import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { query } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import {
  applyPlannedCostLayerConsumption,
  createCostLayer,
  planCostLayerConsumption
} from './costLayers.service';
import {
  persistInventoryMovement
} from '../domains/inventory';
import {
  workOrderVoidReportProductionSchema
} from '../schemas/workOrderExecution.schema';
import {
  hashTransactionalIdempotencyRequest
} from '../lib/transactionalIdempotency';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import {
  runInventoryCommand,
  type InventoryCommandProjectionOp
} from '../modules/platform/application/runInventoryCommand';
import {
  buildPostedDocumentReplayResult,
  buildInventoryBalanceProjectionOp
} from '../modules/platform/application/inventoryMutationSupport';
import {
  restoreReservationsForVoid
} from './inventoryReservation.service';
import * as movementPlanner from './inventoryMovementPlanner';
import * as replayEngine from './inventoryReplayEngine';
import * as statePolicy from './inventoryStatePolicy';
import * as eventFactory from './inventoryEventFactory';
import * as wipEngine from './wipAccountingEngine';
import * as projectionEngine from './inventoryProjectionEngine';
import {
  assertVoidReason,
  normalizedOptionalIdempotencyKey
} from './workOrderExecution.request';
import type {
  LockedExecutionRow,
  MovementLineScopeRow,
  ExistingVoidMovementsRow
} from './workOrderExecution.types';

type WorkOrderVoidReportProductionInput = z.infer<typeof workOrderVoidReportProductionSchema>;

export type WorkOrderVoidReportResult = {
  workOrderId: string;
  workOrderExecutionId: string;
  componentReturnMovementId: string;
  outputReversalMovementId: string;
  idempotencyKey: string | null;
  replayed: boolean;
};

const WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE = 'work_order_batch_void_output';
const WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE = 'work_order_batch_void_components';
const WORK_ORDER_POST_RETRY_OPTIONS = { isolationLevel: 'SERIALIZABLE' as const, retries: 8 };

type DomainError = Error & {
  code?: string;
  details?: Record<string, unknown>;
};

function domainError(code: string, details?: Record<string, unknown>): DomainError {
  const error = new Error(code) as DomainError;
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function assertSameWorkOrderExecution(
  workOrderId: string,
  execution: LockedExecutionRow
) {
  if (execution.work_order_id !== workOrderId) {
    throw new Error('WO_VOID_EXECUTION_WORK_ORDER_MISMATCH');
  }
}

async function findExistingVoidMovements(
  client: PoolClient,
  tenantId: string,
  executionId: string
) {
  const result = await client.query<ExistingVoidMovementsRow>(
    `SELECT id, source_type, status
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_id = $2
        AND source_type IN ($3, $4)
      FOR UPDATE`,
    [
      tenantId,
      executionId,
      WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE,
      WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE
    ]
  );
  return result.rows;
}

async function fetchVoidMovementPair(
  client: PoolClient,
  tenantId: string,
  executionId: string
) {
  const rows = await findExistingVoidMovements(client, tenantId, executionId);
  const component = rows.find((row) => row.source_type === WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE);
  const output = rows.find((row) => row.source_type === WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE);
  if (!component || !output) {
    return null;
  }
  if (component.status !== 'posted' || output.status !== 'posted') {
    throw new Error('WO_VOID_INCOMPLETE');
  }
  return {
    componentReturnMovementId: component.id,
    outputReversalMovementId: output.id
  };
}

async function loadMovementLineScopes(
  client: PoolClient,
  tenantId: string,
  movementId: string,
  quantitySign: 'positive' | 'negative'
) {
  const comparator = quantitySign === 'positive' ? '>' : '<';
  const result = await client.query<MovementLineScopeRow>(
    `SELECT iml.item_id,
            iml.location_id,
            l.warehouse_id,
            COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) AS qty_canonical,
            COALESCE(iml.canonical_uom, iml.uom) AS balance_uom,
            iml.unit_cost,
            iml.extended_cost
       FROM inventory_movement_lines iml
       JOIN locations l
         ON l.id = iml.location_id
        AND l.tenant_id = iml.tenant_id
      WHERE iml.tenant_id = $1
        AND iml.movement_id = $2
        AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) ${comparator} 0
      ORDER BY iml.item_id, iml.location_id, iml.id
      FOR UPDATE`,
    [tenantId, movementId]
  );
  return result.rows;
}

function movementLineUnitCost(line: MovementLineScopeRow): number {
  const qty = Math.abs(roundQuantity(toNumber(line.qty_canonical)));
  const extendedCost = line.extended_cost !== null ? Math.abs(toNumber(line.extended_cost)) : null;
  if (extendedCost !== null && qty > 0) {
    return roundQuantity(extendedCost / qty);
  }
  return roundQuantity(Math.abs(toNumber(line.unit_cost ?? 0)));
}

async function assertVoidOutputStillInQa(
  client: PoolClient,
  tenantId: string,
  executionId: string,
  productionMovementId: string
) {
  const layerRows = await client.query<{
    id: string;
    remaining_quantity: string | number;
    original_quantity: string | number;
    location_id: string;
  }>(
    `SELECT id, remaining_quantity, original_quantity, location_id
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND movement_id = $2
        AND source_type = 'production'
        AND voided_at IS NULL
      FOR UPDATE`,
    [tenantId, productionMovementId]
  );
  if (layerRows.rowCount === 0) {
    throw new Error('WO_VOID_PRODUCTION_LAYER_MISSING');
  }

  const consumedRows = await client.query(
    `SELECT 1
       FROM cost_layer_consumptions
      WHERE tenant_id = $1
        AND cost_layer_id = ANY($2::uuid[])
      LIMIT 1`,
    [tenantId, layerRows.rows.map((row) => row.id)]
  );
  if ((consumedRows.rowCount ?? 0) > 0) {
    throw domainError('WO_VOID_OUTPUT_ALREADY_MOVED', {
      workOrderExecutionId: executionId
    });
  }

  for (const row of layerRows.rows) {
    const remaining = roundQuantity(toNumber(row.remaining_quantity));
    const original = roundQuantity(toNumber(row.original_quantity));
    if (Math.abs(remaining - original) > 1e-6) {
      throw domainError('WO_VOID_OUTPUT_ALREADY_MOVED', {
        workOrderExecutionId: executionId
      });
    }
    const roleRes = await client.query<{ role: string | null }>(
      `SELECT role
         FROM locations
        WHERE id = $1
          AND tenant_id = $2`,
      [row.location_id, tenantId]
    );
    if (roleRes.rows[0]?.role !== 'QA') {
      throw new Error('WO_VOID_OUTPUT_NOT_QA');
    }
  }
}

async function buildWorkOrderVoidReplayResult(params: {
  tenantId: string;
  workOrderId: string;
  executionId: string;
  componentReturnMovementId: string;
  outputReversalMovementId: string;
  expectedComponentLineCount?: number;
  expectedOutputLineCount?: number;
  expectedComponentDeterministicHash?: string | null;
  expectedOutputDeterministicHash?: string | null;
  client: PoolClient;
  idempotencyKey?: string | null;
  preFetchIntegrityCheck: () => Promise<void>;
  fetchAggregateView: () => Promise<WorkOrderVoidReportResult | null>;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      {
        movementId: params.componentReturnMovementId,
        expectedLineCount: params.expectedComponentLineCount,
        expectedDeterministicHash: params.expectedComponentDeterministicHash ?? null
      },
      {
        movementId: params.outputReversalMovementId,
        expectedLineCount: params.expectedOutputLineCount,
        expectedDeterministicHash: params.expectedOutputDeterministicHash ?? null
      }
    ],
    client: params.client,
    preFetchIntegrityCheck: params.preFetchIntegrityCheck,
    fetchAggregateView: params.fetchAggregateView,
    aggregateNotFoundError: new Error('WO_VOID_EXECUTION_NOT_FOUND'),
    authoritativeEvents: [
      eventFactory.buildInventoryMovementPostedEvent(params.componentReturnMovementId, params.idempotencyKey ?? null),
      eventFactory.buildInventoryMovementPostedEvent(params.outputReversalMovementId, params.idempotencyKey ?? null),
      eventFactory.buildWorkOrderProductionReversedEvent({
        executionId: params.executionId,
        workOrderId: params.workOrderId,
        componentReturnMovementId: params.componentReturnMovementId,
        outputReversalMovementId: params.outputReversalMovementId,
        producerIdempotencyKey: params.idempotencyKey ?? null
      })
    ]
  });
}

export async function fetchWorkOrderVoidReportResult(
  tenantId: string,
  workOrderId: string,
  workOrderExecutionId: string,
  client?: PoolClient
): Promise<WorkOrderVoidReportResult | null> {
  const executor = client ? client.query.bind(client) : query;
  const executionRes = await executor<LockedExecutionRow>(
    `SELECT id, work_order_id, status, occurred_at, consumption_movement_id, production_movement_id
       FROM work_order_executions
      WHERE tenant_id = $1
        AND id = $2
        AND work_order_id = $3`,
    [tenantId, workOrderExecutionId, workOrderId]
  );
  if (executionRes.rowCount === 0) {
    return null;
  }
  const movementRes = await executor<ExistingVoidMovementsRow>(
    `SELECT id, source_type, status
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_id = $2
        AND source_type IN ($3, $4)`,
    [
      tenantId,
      workOrderExecutionId,
      WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE,
      WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE
    ]
  );
  const component = movementRes.rows.find((row) => row.source_type === WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE);
  const output = movementRes.rows.find((row) => row.source_type === WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE);
  if (!component || !output || component.status !== 'posted' || output.status !== 'posted') {
    return null;
  }
  return {
    workOrderId,
    workOrderExecutionId,
    componentReturnMovementId: component.id,
    outputReversalMovementId: output.id,
    idempotencyKey: null,
    replayed: true
  };
}

export async function voidWorkOrderProductionReport(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderVoidReportProductionInput,
  actor: { type: 'user' | 'system'; id?: string | null },
  options?: { idempotencyKey?: string | null }
): Promise<WorkOrderVoidReportResult> {
  const idempotencyKey = normalizedOptionalIdempotencyKey(options?.idempotencyKey ?? data.idempotencyKey ?? null);
  const reason = assertVoidReason(data.reason);
  const idempotencyRequestHash = idempotencyKey
    ? hashTransactionalIdempotencyRequest({
      method: 'POST',
      endpoint: IDEMPOTENCY_ENDPOINTS.WORK_ORDER_VOID_REPORT_PRODUCTION,
      body: {
        workOrderId,
        workOrderExecutionId: data.workOrderExecutionId,
        reason,
        notes: data.notes ?? null
      }
    })
    : null;

  let execution: LockedExecutionRow | null = null;
  let componentLines: MovementLineScopeRow[] = [];
  let outputLines: MovementLineScopeRow[] = [];

  return runInventoryCommand<WorkOrderVoidReportResult>({
    tenantId,
    endpoint: IDEMPOTENCY_ENDPOINTS.WORK_ORDER_VOID_REPORT_PRODUCTION,
    operation: 'work_order_batch_void',
    idempotencyKey,
    requestHash: idempotencyRequestHash,
    retryOptions: WORK_ORDER_POST_RETRY_OPTIONS,
    onReplay: async ({ client, responseBody }) => {
      const replay = await replayEngine.replayVoid({
          tenantId,
          workOrderId: responseBody.workOrderId,
          executionId: responseBody.workOrderExecutionId,
          componentReturnMovementId: responseBody.componentReturnMovementId,
          outputReversalMovementId: responseBody.outputReversalMovementId,
          client,
          idempotencyKey,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, responseBody.workOrderId);
          },
          fetchAggregateView: async () => {
            const res = await client.query<{ id: string; work_order_id: string }>(
              `SELECT id, work_order_id
                 FROM work_order_executions
                WHERE tenant_id = $1
                  AND id = $2
                  AND work_order_id = $3
                FOR UPDATE`,
              [tenantId, responseBody.workOrderExecutionId, responseBody.workOrderId]
            );
            if (res.rowCount === 0) {
              return null;
            }
            return {
              workOrderId: responseBody.workOrderId,
              workOrderExecutionId: responseBody.workOrderExecutionId,
              componentReturnMovementId: responseBody.componentReturnMovementId,
              outputReversalMovementId: responseBody.outputReversalMovementId,
              idempotencyKey,
              replayed: true
            };
          }
        });
      return replay.responseBody as WorkOrderVoidReportResult;
    },
    lockTargets: async (client) => {
      const executionRes = await client.query<LockedExecutionRow>(
        `SELECT id,
                work_order_id,
                status,
                occurred_at,
                consumption_movement_id,
                production_movement_id
           FROM work_order_executions
          WHERE tenant_id = $1
            AND id = $2
            AND work_order_id = $3
          FOR UPDATE`,
        [tenantId, data.workOrderExecutionId, workOrderId]
      );
      if (executionRes.rowCount === 0) {
        throw new Error('WO_VOID_EXECUTION_NOT_FOUND');
      }
      execution = executionRes.rows[0];
      assertSameWorkOrderExecution(workOrderId, execution);
      const currentState =
        execution.status === 'posted' && execution.production_movement_id && execution.consumption_movement_id
          ? 'reported_production'
          : execution.status === 'posted'
            ? 'posted_completion'
            : 'planned_completion';
      statePolicy.assertManufacturingTransition({
        flow: 'reversal',
        currentState,
        allowedFrom: ['reported_production'],
        targetState: 'reversal',
        workOrderId,
        executionOrDocumentId: execution.id
      });
      if (!execution.consumption_movement_id || !execution.production_movement_id) {
        throw new Error('WO_VOID_EXECUTION_MOVEMENTS_MISSING');
      }

      const existingPair = await fetchVoidMovementPair(client, tenantId, execution.id);
      if (existingPair) {
        return [];
      }

      const originalMovements = await client.query<{
        id: string;
        movement_type: string;
        status: string;
      }>(
        `SELECT id, movement_type, status
           FROM inventory_movements
          WHERE tenant_id = $1
            AND id = ANY($2::uuid[])
          FOR UPDATE`,
        [tenantId, [execution.consumption_movement_id, execution.production_movement_id]]
      );
      const currentExecution = execution;
      if (!currentExecution) {
        throw new Error('WO_VOID_EXECUTION_NOT_FOUND');
      }
      const originalIssue = originalMovements.rows.find(
        (row) => row.id === currentExecution.consumption_movement_id
      );
      const originalProduction = originalMovements.rows.find(
        (row) => row.id === currentExecution.production_movement_id
      );
      if (!originalIssue || !originalProduction) {
        throw new Error('WO_VOID_EXECUTION_MOVEMENTS_MISSING');
      }
      if (originalIssue.status !== 'posted' || originalProduction.status !== 'posted') {
        throw new Error('WO_VOID_EXECUTION_NOT_POSTED');
      }
      if (originalIssue.movement_type !== 'issue' || originalProduction.movement_type !== 'receive') {
        throw new Error('WO_VOID_EXECUTION_MOVEMENT_TYPE_INVALID');
      }

      componentLines = await loadMovementLineScopes(
        client,
        tenantId,
        execution.consumption_movement_id,
        'negative'
      );
      outputLines = await loadMovementLineScopes(
        client,
        tenantId,
        execution.production_movement_id,
        'positive'
      );
      if (componentLines.length === 0 || outputLines.length === 0) {
        throw new Error('WO_VOID_EXECUTION_MOVEMENTS_MISSING');
      }

      await assertVoidOutputStillInQa(
        client,
        tenantId,
        execution.id,
        execution.production_movement_id
      );

      const missingWarehouseBindings = [
        ...componentLines.filter((line) => !line.warehouse_id).map((line) => line.location_id),
        ...outputLines.filter((line) => !line.warehouse_id).map((line) => line.location_id)
      ];
      if (missingWarehouseBindings.length > 0) {
        throw new Error(
          `WO_VOID_LOCATION_WAREHOUSE_MISSING:${Array.from(new Set(missingWarehouseBindings)).join(',')}`
        );
      }

      return [
        ...componentLines.map((line) => ({
          tenantId,
          warehouseId: line.warehouse_id ?? '',
          itemId: line.item_id
        })),
        ...outputLines.map((line) => ({
          tenantId,
          warehouseId: line.warehouse_id ?? '',
          itemId: line.item_id
        }))
      ];
    },
    execute: async ({ client }) => {
      if (!execution) {
        throw new Error('WO_VOID_EXECUTION_NOT_FOUND');
      }

      if (
        componentLines.length === 0
        && outputLines.length === 0
        && execution.consumption_movement_id
        && execution.production_movement_id
      ) {
        componentLines = await loadMovementLineScopes(
          client,
          tenantId,
          execution.consumption_movement_id,
          'negative'
        );
        outputLines = await loadMovementLineScopes(
          client,
          tenantId,
          execution.production_movement_id,
          'positive'
        );
      }
      const currentExecution = execution;

      const outputLineBySourceId = new Map<string, MovementLineScopeRow>();
      const outputPlannerLines: movementPlanner.RawMovementLineDescriptor[] = outputLines.map((line) => {
        const quantityToReverse = Math.abs(roundQuantity(toNumber(line.qty_canonical)));
        const sourceLineId = `${line.item_id}:${line.location_id}:${line.balance_uom}:${quantityToReverse}`;
        outputLineBySourceId.set(sourceLineId, line);
        return {
          sourceLineId,
          warehouseId: line.warehouse_id ?? '',
          itemId: line.item_id,
          locationId: line.location_id,
          quantity: -quantityToReverse,
          uom: line.balance_uom,
          defaultReasonCode: 'work_order_void_output',
          lineNotes: `Void output reversal for work order execution ${currentExecution.id}`
        };
      });
      const componentLineBySourceId = new Map<string, MovementLineScopeRow>();
      const componentPlannerLines: movementPlanner.RawMovementLineDescriptor[] = componentLines.map((line) => {
        const quantityToReturn = Math.abs(roundQuantity(toNumber(line.qty_canonical)));
        const sourceLineId = `${line.item_id}:${line.location_id}:${line.balance_uom}:${quantityToReturn}`;
        componentLineBySourceId.set(sourceLineId, line);
        return {
          sourceLineId,
          warehouseId: line.warehouse_id ?? '',
          itemId: line.item_id,
          locationId: line.location_id,
          quantity: quantityToReturn,
          uom: line.balance_uom,
          defaultReasonCode: 'work_order_void_component_return',
          lineNotes: `Void component return for work order execution ${currentExecution.id}`
        };
      });
      const now = new Date();
      const outputMovementId = uuidv4();
      const componentMovementId = uuidv4();
      const baseVoidMovement = await movementPlanner.buildVoidMovement({
        client,
        outputHeader: {
          id: outputMovementId,
          tenantId,
          movementType: 'issue',
          status: 'posted',
          externalRef: `${WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE}:${currentExecution.id}:${workOrderId}`,
          sourceType: WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE,
          sourceId: currentExecution.id,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:output` : null,
          occurredAt: now,
          postedAt: now,
          notes: data.notes ?? `Void production output for execution ${currentExecution.id}: ${reason}`,
          metadata: {
            workOrderId,
            workOrderExecutionId: currentExecution.id,
            reason
          },
          createdAt: now,
          updatedAt: now
        },
        outputLines: outputPlannerLines,
        componentHeader: {
          id: componentMovementId,
          tenantId,
          movementType: 'receive',
          status: 'posted',
          externalRef: `${WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE}:${currentExecution.id}:${workOrderId}`,
          sourceType: WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE,
          sourceId: currentExecution.id,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:components` : null,
          occurredAt: now,
          postedAt: now,
          notes: data.notes ?? `Void component return for execution ${currentExecution.id}: ${reason}`,
          metadata: {
            workOrderId,
            workOrderExecutionId: currentExecution.id,
            reason
          },
          createdAt: now,
          updatedAt: now
        },
        componentLines: componentPlannerLines
      });
      const plannedOutputLines = baseVoidMovement.output.sortedLines;
      const plannedComponentLines = baseVoidMovement.components.sortedLines;
      const existingPair = await fetchVoidMovementPair(client, tenantId, execution.id);
      if (existingPair) {
        const replay = await replayEngine.replayVoid({
          tenantId,
          workOrderId,
          executionId: currentExecution.id,
          componentReturnMovementId: existingPair.componentReturnMovementId,
          outputReversalMovementId: existingPair.outputReversalMovementId,
          expectedComponentLineCount: plannedComponentLines.length,
          expectedOutputLineCount: plannedOutputLines.length,
          client,
          idempotencyKey,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
          },
          fetchAggregateView: async () => ({
            workOrderId,
            workOrderExecutionId: currentExecution.id,
            componentReturnMovementId: existingPair.componentReturnMovementId,
            outputReversalMovementId: existingPair.outputReversalMovementId,
            idempotencyKey,
            replayed: true
          })
        });
        return {
          ...replay,
          responseBody: replay.responseBody as WorkOrderVoidReportResult
        };
      }
      const plannedOutputMovementLines = await Promise.all(plannedOutputLines.map(async (plannedOutputLine) => {
        const sourceLine = outputLineBySourceId.get(plannedOutputLine.sourceLineId);
        if (!sourceLine) {
          throw new Error('WO_VOID_OUTPUT_LINE_NOT_FOUND');
        }
        const canonicalQty = Math.abs(plannedOutputLine.canonicalFields.quantityDeltaCanonical);
        const consumptionPlan = await planCostLayerConsumption({
          tenant_id: tenantId,
          item_id: sourceLine.item_id,
          location_id: sourceLine.location_id,
          quantity: canonicalQty,
          consumption_type: 'scrap',
          consumption_document_id: currentExecution.id,
          movement_id: outputMovementId,
          client,
          notes: `work_order_void_output:${currentExecution.id}`
        });
        return {
          plannedOutputLine,
          sourceLine,
          consumptionPlan,
          unitCost: canonicalQty > 0 ? consumptionPlan.total_cost / canonicalQty : null,
          extendedCost: -consumptionPlan.total_cost
        };
      }));
      const plannedComponentMovementLines = plannedComponentLines.map((plannedComponentLine) => {
        const sourceLine = componentLineBySourceId.get(plannedComponentLine.sourceLineId);
        if (!sourceLine) {
          throw new Error('WO_VOID_COMPONENT_LINE_NOT_FOUND');
        }
        const unitCost = movementLineUnitCost(sourceLine);
        const extendedCost = roundQuantity(
          plannedComponentLine.canonicalFields.quantityDeltaCanonical * unitCost
        );
        return {
          plannedComponentLine,
          sourceLine,
          unitCost,
          extendedCost
        };
      });
      const plannedVoidMovement = await movementPlanner.buildVoidMovement({
        client,
        outputHeader: {
          id: outputMovementId,
          tenantId,
          movementType: 'issue',
          status: 'posted',
          externalRef: `${WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE}:${currentExecution.id}:${workOrderId}`,
          sourceType: WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE,
          sourceId: currentExecution.id,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:output` : null,
          occurredAt: now,
          postedAt: now,
          notes: data.notes ?? `Void production output for execution ${currentExecution.id}: ${reason}`,
          metadata: {
            workOrderId,
            workOrderExecutionId: currentExecution.id,
            reason
          },
          createdAt: now,
          updatedAt: now
        },
        outputLines: plannedOutputMovementLines.map(({ plannedOutputLine, sourceLine, unitCost, extendedCost }) => ({
          sourceLineId: plannedOutputLine.sourceLineId,
          warehouseId: plannedOutputLine.warehouseId,
          itemId: sourceLine.item_id,
          locationId: sourceLine.location_id,
          quantity: -Math.abs(roundQuantity(toNumber(sourceLine.qty_canonical))),
          uom: sourceLine.balance_uom,
          defaultReasonCode: 'work_order_void_output',
          lineNotes: plannedOutputLine.lineNotes,
          unitCost,
          extendedCost
        })),
        componentHeader: {
          id: componentMovementId,
          tenantId,
          movementType: 'receive',
          status: 'posted',
          externalRef: `${WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE}:${currentExecution.id}:${workOrderId}`,
          sourceType: WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE,
          sourceId: currentExecution.id,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:components` : null,
          occurredAt: now,
          postedAt: now,
          notes: data.notes ?? `Void component return for execution ${currentExecution.id}: ${reason}`,
          metadata: {
            workOrderId,
            workOrderExecutionId: currentExecution.id,
            reason
          },
          createdAt: now,
          updatedAt: now
        },
        componentLines: plannedComponentMovementLines.map(({ plannedComponentLine, sourceLine, unitCost, extendedCost }) => ({
          sourceLineId: plannedComponentLine.sourceLineId,
          warehouseId: plannedComponentLine.warehouseId,
          itemId: sourceLine.item_id,
          locationId: sourceLine.location_id,
          quantity: Math.abs(roundQuantity(toNumber(sourceLine.qty_canonical))),
          uom: sourceLine.balance_uom,
          defaultReasonCode: 'work_order_void_component_return',
          lineNotes: plannedComponentLine.lineNotes,
          unitCost,
          extendedCost
        }))
      });

      const outputMovement = await persistInventoryMovement(client, plannedVoidMovement.output.persistInput);
      const componentMovement = await persistInventoryMovement(client, plannedVoidMovement.components.persistInput);

      if (!outputMovement.created || !componentMovement.created) {
        const replayPair = await fetchVoidMovementPair(client, tenantId, currentExecution.id);
        if (replayPair) {
          const replay = await replayEngine.replayVoid({
            tenantId,
            workOrderId,
            executionId: currentExecution.id,
            componentReturnMovementId: replayPair.componentReturnMovementId,
            outputReversalMovementId: replayPair.outputReversalMovementId,
            expectedComponentLineCount: plannedVoidMovement.components.expectedLineCount,
            expectedOutputLineCount: plannedVoidMovement.output.expectedLineCount,
            expectedComponentDeterministicHash: plannedVoidMovement.components.expectedDeterministicHash,
            expectedOutputDeterministicHash: plannedVoidMovement.output.expectedDeterministicHash,
            client,
            idempotencyKey,
            preFetchIntegrityCheck: async () => {
              await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
            },
            fetchAggregateView: async () => ({
              workOrderId,
              workOrderExecutionId: currentExecution.id,
              componentReturnMovementId: replayPair.componentReturnMovementId,
              outputReversalMovementId: replayPair.outputReversalMovementId,
              idempotencyKey,
              replayed: true
            })
          });
          return {
            ...replay,
            responseBody: replay.responseBody as WorkOrderVoidReportResult
          };
        }
        throw new Error('WO_VOID_INCOMPLETE');
      }

      const projectionOps: InventoryCommandProjectionOp[] = [];
      let totalOutputReversalCost = 0;
      let totalComponentReturnCost = 0;

      for (const { plannedOutputLine, sourceLine, consumptionPlan } of plannedOutputMovementLines) {
        const canonicalQty = Math.abs(plannedOutputLine.canonicalFields.quantityDeltaCanonical);
        await applyPlannedCostLayerConsumption({
          tenant_id: tenantId,
          item_id: sourceLine.item_id,
          location_id: sourceLine.location_id,
          quantity: canonicalQty,
          consumption_type: 'scrap',
          consumption_document_id: currentExecution.id,
          movement_id: outputMovementId,
          client,
          notes: `work_order_void_output:${currentExecution.id}`,
          plan: consumptionPlan
        });
        totalOutputReversalCost += consumptionPlan.total_cost;
        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: sourceLine.item_id,
            locationId: sourceLine.location_id,
            uom: plannedOutputLine.canonicalFields.canonicalUom,
            deltaOnHand: plannedOutputLine.canonicalFields.quantityDeltaCanonical
          })
        );
      }

      for (const { plannedComponentLine, sourceLine, unitCost, extendedCost } of plannedComponentMovementLines) {
        totalComponentReturnCost += extendedCost;
        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: sourceLine.item_id,
            locationId: sourceLine.location_id,
            uom: plannedComponentLine.canonicalFields.canonicalUom,
            deltaOnHand: plannedComponentLine.canonicalFields.quantityDeltaCanonical
          })
        );
        await createCostLayer({
          tenant_id: tenantId,
          item_id: sourceLine.item_id,
          location_id: sourceLine.location_id,
          uom: plannedComponentLine.canonicalFields.canonicalUom,
          quantity: plannedComponentLine.canonicalFields.quantityDeltaCanonical,
          unit_cost: unitCost,
          source_type: 'adjustment',
          source_document_id: currentExecution.id,
          movement_id: componentMovementId,
          notes: `Work-order void component return for execution ${currentExecution.id}`,
          client
        });
      }

      await wipEngine.reverseWipCost(client, {
        tenantId,
        workOrderId,
        executionId: currentExecution.id,
        originalIssueMovementId: currentExecution.consumption_movement_id!,
        originalReportMovementId: currentExecution.production_movement_id!,
        outputMovementId: outputMovementId,
        componentMovementId: componentMovementId,
        outputReversalCost: totalOutputReversalCost,
        componentReturnCost: totalComponentReturnCost
      });
      await restoreReservationsForVoid(tenantId, workOrderId, currentExecution.id, client);

      projectionOps.push(
        ...projectionEngine.buildVoidProjectionOps({
          tenantId,
          workOrderId,
          executionId: currentExecution.id,
          outputReversalMovementId: outputMovementId,
          componentReturnMovementId: componentMovementId,
          reason,
          actor,
          now
        })
      );

      return {
        responseBody: {
          workOrderId,
          workOrderExecutionId: currentExecution.id,
          componentReturnMovementId: componentMovementId,
          outputReversalMovementId: outputMovementId,
          idempotencyKey,
          replayed: false
        },
        responseStatus: 201,
        events: [
          eventFactory.buildInventoryMovementPostedEvent(componentMovementId, idempotencyKey),
          eventFactory.buildInventoryMovementPostedEvent(outputMovementId, idempotencyKey),
          eventFactory.buildWorkOrderProductionReversedEvent({
            executionId: currentExecution.id,
            workOrderId,
            componentReturnMovementId: componentMovementId,
            outputReversalMovementId: outputMovementId,
            producerIdempotencyKey: idempotencyKey
          })
        ],
        projectionOps
      };
    }
  });
}
