import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query } from '../db';
import { toNumber } from '../lib/numbers';
import { createCostLayer } from './costLayers.service';
import { resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import { persistInventoryMovement } from '../domains/inventory';
import {
  runInventoryCommand,
  type InventoryCommandProjectionOp
} from '../modules/platform/application/runInventoryCommand';
import {
  buildPostedDocumentReplayResult,
  buildInventoryBalanceProjectionOp
} from '../modules/platform/application/inventoryMutationSupport';
import { isTerminalWorkOrderStatus } from './workOrderLifecycle.service';
import * as movementPlanner from './inventoryMovementPlanner';
import * as statePolicy from './inventoryStatePolicy';
import * as eventFactory from './inventoryEventFactory';
import * as wipEngine from './wipAccountingEngine';
import * as projectionEngine from './inventoryProjectionEngine';
import { compareProduceLineLockKey } from './workOrderExecution.ordering';
import { mapExecution } from './workOrderExecution.response';
import type {
  LockedExecutionRow,
  ManufacturingMutationState,
  WorkOrderExecutionLineRow,
  WorkOrderExecutionRow,
  WorkOrderRow
} from './workOrderExecution.types';

type WorkOrderCompletionRecord = ReturnType<typeof mapExecution>;
type DomainError = Error & {
  code?: string;
  details?: Record<string, unknown>;
};

const WIP_COST_METHOD = 'fifo';
const WORK_ORDER_POST_RETRY_OPTIONS = { isolationLevel: 'SERIALIZABLE' as const, retries: 8 };

function domainError(code: string, details?: Record<string, unknown>): DomainError {
  const error = new Error(code) as DomainError;
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

async function buildWorkOrderCompletionReplayResult(params: {
  tenantId: string;
  workOrderId: string;
  completionId: string;
  movementId: string;
  expectedLineCount?: number;
  expectedDeterministicHash?: string | null;
  client: PoolClient;
  idempotencyKey?: string | null;
  preFetchIntegrityCheck: () => Promise<void>;
  fetchAggregateView: () => Promise<WorkOrderCompletionRecord | null>;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      {
        movementId: params.movementId,
        expectedLineCount: params.expectedLineCount,
        expectedDeterministicHash: params.expectedDeterministicHash ?? null
      }
    ],
    client: params.client,
    preFetchIntegrityCheck: params.preFetchIntegrityCheck,
    fetchAggregateView: params.fetchAggregateView,
    aggregateNotFoundError: new Error('WO_COMPLETION_NOT_FOUND'),
    authoritativeEvents: [
      eventFactory.buildInventoryMovementPostedEvent(params.movementId, params.idempotencyKey ?? null),
      eventFactory.buildWorkOrderCompletionPostedEvent({
        executionId: params.completionId,
        workOrderId: params.workOrderId,
        movementId: params.movementId,
        producerIdempotencyKey: params.idempotencyKey ?? null
      })
    ]
  });
}

type WorkOrderCompletionReplayResult = Awaited<ReturnType<typeof buildWorkOrderCompletionReplayResult>> & {
  responseBody: WorkOrderCompletionRecord;
};

function deriveCompletionMutationState(params: {
  execution: WorkOrderExecutionRow | LockedExecutionRow;
  flow: 'completion' | 'report';
}): ManufacturingMutationState {
  if (params.execution.status === 'draft') {
    return 'planned_completion';
  }
  if (params.execution.status === 'posted' && params.execution.production_movement_id) {
    return params.flow === 'report' ? 'reported_production' : 'posted_completion';
  }
  throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
    flow: params.flow,
    executionId: params.execution.id,
    reason: params.execution.status === 'posted'
      ? 'posted_completion_missing_authoritative_movement'
      : 'completion_state_unrecognized'
  });
}

async function fetchWorkOrderById(
  tenantId: string,
  id: string,
  client?: PoolClient,
  options?: { forUpdate?: boolean }
): Promise<WorkOrderRow | null> {
  const executor = client ? client.query.bind(client) : query;
  const lockClause = client && options?.forUpdate ? ' FOR UPDATE' : '';
  const result = await executor<WorkOrderRow>(
    `SELECT *
       FROM work_orders
      WHERE id = $1
        AND tenant_id = $2${lockClause}`,
    [id, tenantId]
  );
  return result.rowCount === 0 ? null : result.rows[0];
}

export async function fetchWorkOrderCompletion(
  tenantId: string,
  workOrderId: string,
  completionId: string,
  client?: PoolClient
) {
  const executor = client ? client.query.bind(client) : query;
  const headerResult = await executor<WorkOrderExecutionRow>(
    'SELECT * FROM work_order_executions WHERE id = $1 AND work_order_id = $2 AND tenant_id = $3',
    [completionId, workOrderId, tenantId]
  );
  if (headerResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor<WorkOrderExecutionLineRow>(
    'SELECT * FROM work_order_execution_lines WHERE work_order_execution_id = $1 AND tenant_id = $2 ORDER BY created_at ASC',
    [completionId, tenantId]
  );
  return mapExecution(headerResult.rows[0], linesResult.rows);
}

export async function postWorkOrderCompletion(
  tenantId: string,
  workOrderId: string,
  completionId: string
) {
  let workOrder: WorkOrderRow | null = null;
  let execution: WorkOrderExecutionRow | null = null;
  let completionState: ManufacturingMutationState | null = null;
  let linesForPosting: WorkOrderExecutionLineRow[] = [];
  let warehouseIdsByLocation = new Map<string, string>();

  return runInventoryCommand<WorkOrderCompletionRecord>({
    tenantId,
    endpoint: 'wo.completion.post',
    operation: 'work_order_completion_post',
    retryOptions: WORK_ORDER_POST_RETRY_OPTIONS,
    lockTargets: async (client) => {
      workOrder = await fetchWorkOrderById(tenantId, workOrderId, client, { forUpdate: true });
      if (!workOrder) {
        throw new Error('WO_NOT_FOUND');
      }
      if (isTerminalWorkOrderStatus(workOrder.status)) {
        throw new Error('WO_INVALID_STATE');
      }

      const execResult = await client.query<WorkOrderExecutionRow>(
        `SELECT *
           FROM work_order_executions
          WHERE id = $1
            AND work_order_id = $2
            AND tenant_id = $3
          FOR UPDATE`,
        [completionId, workOrderId, tenantId]
      );
      if (execResult.rowCount === 0) {
        throw new Error('WO_COMPLETION_NOT_FOUND');
      }
      execution = execResult.rows[0];
      if (execution.status === 'canceled') {
        throw new Error('WO_COMPLETION_CANCELED');
      }
      completionState = deriveCompletionMutationState({
        execution,
        flow: 'completion'
      });
      if (completionState === 'posted_completion') {
        if (!execution.production_movement_id) {
          throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
            flow: 'completion',
            completionId,
            reason: 'posted_completion_missing_authoritative_movement'
          });
        }
        return [];
      }

      const linesResult = await client.query<WorkOrderExecutionLineRow>(
        `SELECT *
           FROM work_order_execution_lines
          WHERE work_order_execution_id = $1
            AND tenant_id = $2
          ORDER BY created_at ASC`,
        [completionId, tenantId]
      );
      if (linesResult.rowCount === 0) {
        throw new Error('WO_COMPLETION_NO_LINES');
      }
      linesForPosting = [...linesResult.rows].sort(compareProduceLineLockKey);
      const isDisassembly = workOrder.kind === 'disassembly';
      warehouseIdsByLocation = new Map<string, string>();
      for (const line of linesForPosting) {
        if (line.line_type !== 'produce') {
          throw new Error('WO_COMPLETION_INVALID_LINE_TYPE');
        }
        if (!isDisassembly && line.item_id !== workOrder.output_item_id) {
          throw new Error('WO_COMPLETION_ITEM_MISMATCH');
        }
        if (!line.to_location_id) {
          throw new Error('WO_COMPLETION_LOCATION_REQUIRED');
        }
        const qty = toNumber(line.quantity);
        if (qty <= 0) {
          throw new Error('WO_COMPLETION_INVALID_QUANTITY');
        }
        if (!warehouseIdsByLocation.has(line.to_location_id)) {
          warehouseIdsByLocation.set(
            line.to_location_id,
            await resolveWarehouseIdForLocation(tenantId, line.to_location_id, client)
          );
        }
      }
      return linesForPosting.map((line) => ({
        tenantId,
        warehouseId: warehouseIdsByLocation.get(line.to_location_id!) ?? '',
        itemId: line.item_id
      }));
    },
    execute: async ({ client }) => {
      if (!workOrder || !execution || !completionState) {
        throw new Error('WO_COMPLETION_NOT_FOUND');
      }
      const isDisassembly = workOrder.kind === 'disassembly';
      const lineById = new Map<string, WorkOrderExecutionLineRow>();
      const plannerLines: movementPlanner.RawMovementLineDescriptor[] = [];
      let totalProduced = 0;
      for (const line of linesForPosting) {
        const qty = toNumber(line.quantity);
        totalProduced += qty;
        lineById.set(line.id, line);
        plannerLines.push({
          sourceLineId: line.id,
          warehouseId: warehouseIdsByLocation.get(line.to_location_id!) ?? '',
          itemId: line.item_id,
          locationId: line.to_location_id!,
          quantity: qty,
          uom: line.uom,
          defaultReasonCode: isDisassembly ? 'disassembly_completion' : 'work_order_completion',
          explicitReasonCode: line.reason_code,
          lineNotes: line.notes ?? `Work order completion ${completionId}`
        });
      }
      const occurredAt = new Date(execution.occurred_at);
      const baseCompletionMovement = await movementPlanner.buildCompletionMovement({
        client,
        header: {
          id: execution.production_movement_id ?? uuidv4(),
          tenantId,
          movementType: 'receive',
          status: 'posted',
          externalRef: isDisassembly
            ? `work_order_disassembly_completion:${completionId}:${workOrderId}`
            : `work_order_completion:${completionId}:${workOrderId}`,
          sourceType: 'work_order_completion_post',
          sourceId: completionId,
          idempotencyKey: `wo-completion-post:${completionId}`,
          occurredAt,
          postedAt: occurredAt,
          notes: execution.notes ?? null,
          metadata: {
            workOrderId,
            workOrderNumber: workOrder.number ?? workOrder.work_order_number
          },
          createdAt: occurredAt,
          updatedAt: occurredAt
        },
        lines: plannerLines
      });
      const sortedMovementLines = baseCompletionMovement.sortedLines;
      const totalProducedCanonical = sortedMovementLines.reduce(
        (sum, line) => sum + line.canonicalFields.quantityDeltaCanonical,
        0
      );
      if (completionState === 'posted_completion') {
        const replay = await buildWorkOrderCompletionReplayResult({
          tenantId,
          workOrderId,
          completionId,
          movementId: execution.production_movement_id!,
          expectedLineCount: baseCompletionMovement.expectedLineCount,
          expectedDeterministicHash: baseCompletionMovement.expectedDeterministicHash,
          client,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
          },
          fetchAggregateView: () =>
            fetchWorkOrderCompletion(tenantId, workOrderId, completionId, client)
        }) as WorkOrderCompletionReplayResult;
        return replay;
      }

      statePolicy.assertManufacturingTransition({
        flow: 'completion',
        currentState: completionState,
        allowedFrom: ['planned_completion'],
        targetState: 'posted_completion',
        workOrderId,
        executionOrDocumentId: completionId
      });

      const now = new Date();
      if (totalProducedCanonical <= 0) {
        throw new Error('WO_WIP_COST_INVALID_OUTPUT_QTY');
      }
      const pendingWipAllocation = await wipEngine.lockOpenWip(client, {
        tenantId,
        scope: { kind: 'workOrder', workOrderId }
      });
      const totalIssueCost = pendingWipAllocation.totalCost;
      const plannedMovementLines = sortedMovementLines.map((preparedLine) => {
        const sourceLine = lineById.get(preparedLine.sourceLineId);
        if (!sourceLine) {
          throw new Error('WO_COMPLETION_LINE_NOT_FOUND');
        }
        const allocationRatio = preparedLine.canonicalFields.quantityDeltaCanonical / totalProducedCanonical;
        const allocatedCost = totalIssueCost * allocationRatio;
        const unitCost =
          preparedLine.canonicalFields.quantityDeltaCanonical !== 0
            ? allocatedCost / preparedLine.canonicalFields.quantityDeltaCanonical
            : null;
        return {
          preparedLine,
          sourceLine,
          allocatedCost,
          unitCost
        };
      });
      const movementId = uuidv4();
      const plannedCompletionMovement = await movementPlanner.buildCompletionMovement({
        client,
        header: {
          id: movementId,
          tenantId,
          movementType: 'receive',
          status: 'posted',
          externalRef: isDisassembly
            ? `work_order_disassembly_completion:${completionId}:${workOrderId}`
            : `work_order_completion:${completionId}:${workOrderId}`,
          sourceType: 'work_order_completion_post',
          sourceId: completionId,
          idempotencyKey: `wo-completion-post:${completionId}`,
          occurredAt,
          postedAt: now,
          notes: execution.notes ?? null,
          metadata: {
            workOrderId,
            workOrderNumber: workOrder.number ?? workOrder.work_order_number
          },
          createdAt: now,
          updatedAt: now
        },
        lines: plannedMovementLines.map(({ preparedLine, sourceLine, allocatedCost, unitCost }) => ({
          sourceLineId: preparedLine.sourceLineId,
          warehouseId: preparedLine.warehouseId,
          itemId: sourceLine.item_id,
          locationId: sourceLine.to_location_id!,
          quantity: toNumber(sourceLine.quantity),
          uom: sourceLine.uom,
          defaultReasonCode: isDisassembly ? 'disassembly_completion' : 'work_order_completion',
          explicitReasonCode: sourceLine.reason_code,
          lineNotes: sourceLine.notes ?? `Work order completion ${completionId}`,
          unitCost,
          extendedCost: allocatedCost
        }))
      });
      const movement = await persistInventoryMovement(client, plannedCompletionMovement.persistInput);

      if (!movement.created) {
        const replay = await buildWorkOrderCompletionReplayResult({
          tenantId,
          workOrderId,
          completionId,
          movementId: movement.movementId,
          expectedLineCount: plannedCompletionMovement.expectedLineCount,
          expectedDeterministicHash: plannedCompletionMovement.expectedDeterministicHash,
          client,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
          },
          fetchAggregateView: () =>
            fetchWorkOrderCompletion(tenantId, workOrderId, completionId, client)
        }) as WorkOrderCompletionReplayResult;
        return replay;
      }
      const wipUnitCostCanonical = totalIssueCost / totalProducedCanonical;

      const projectionOps: InventoryCommandProjectionOp[] = [];
      for (const { preparedLine, sourceLine, unitCost } of plannedMovementLines) {
        await createCostLayer({
          tenant_id: tenantId,
          item_id: sourceLine.item_id,
          location_id: sourceLine.to_location_id!,
          uom: preparedLine.canonicalFields.canonicalUom,
          quantity: preparedLine.canonicalFields.quantityDeltaCanonical,
          unit_cost: unitCost ?? 0,
          source_type: 'production',
          source_document_id: completionId,
          movement_id: movement.movementId,
          notes: `Production output from work order ${workOrderId}`,
          client
        });
        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: sourceLine.item_id,
            locationId: sourceLine.to_location_id!,
            uom: preparedLine.canonicalFields.canonicalUom,
            deltaOnHand: preparedLine.canonicalFields.quantityDeltaCanonical
          })
        );
      }
      await wipEngine.allocateWipCost(client, {
        tenantId,
        executionId: completionId,
        allocatedAt: now,
        pending: pendingWipAllocation
      });

      const completionUomSet = new Set(
        sortedMovementLines.map((line) => line.canonicalFields.canonicalUom)
      );
      const completionCanonicalUom =
        completionUomSet.size === 1 ? sortedMovementLines[0]?.canonicalFields.canonicalUom ?? null : null;
      await wipEngine.createWipValuationRecord(client, {
        tenantId,
        workOrderId,
        executionId: completionId,
        movementId: movement.movementId,
        valuationType: 'completion',
        valueDelta: -totalIssueCost,
        quantityCanonical: completionCanonicalUom ? totalProducedCanonical : null,
        canonicalUom: completionCanonicalUom,
        notes: `Work-order completion WIP capitalization for execution ${completionId}`
      });
      await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
      projectionOps.push(
        ...projectionEngine.buildCompletionProjectionOps({
          tenantId,
          completionId,
          movementId: movement.movementId,
          now,
          workOrderId,
          workOrder,
          isDisassembly,
          totalIssueCost,
          wipUnitCostCanonical,
          totalProducedCanonical,
          totalProduced
        })
      );

      return {
        responseBody: mapExecution(
          {
            ...execution,
            status: 'posted',
            production_movement_id: movement.movementId,
            wip_total_cost: totalIssueCost,
            wip_unit_cost: wipUnitCostCanonical,
            wip_quantity_canonical: totalProducedCanonical,
            wip_cost_method: WIP_COST_METHOD,
            wip_costed_at: now.toISOString()
          },
          linesForPosting
        ),
        responseStatus: 200,
        events: [
          eventFactory.buildInventoryMovementPostedEvent(movement.movementId),
          eventFactory.buildWorkOrderCompletionPostedEvent({
            executionId: completionId,
            workOrderId,
            movementId: movement.movementId
          })
        ],
        projectionOps
      };
    }
  });
}
