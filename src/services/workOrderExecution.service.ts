import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { fetchBomById } from './boms.service';
import {
  applyPlannedCostLayerConsumption,
  createCostLayer,
  planCostLayerConsumption
} from './costLayers.service';
import { getWarehouseDefaultLocationId, resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import {
  persistInventoryMovement
} from '../domains/inventory';
import {
  workOrderCompletionCreateSchema,
  workOrderIssueCreateSchema,
  workOrderBatchSchema,
  workOrderReportProductionSchema,
  workOrderReportScrapSchema,
  workOrderVoidReportProductionSchema
} from '../schemas/workOrderExecution.schema';
import {
  buildTransferLockTargets,
  executeTransferInventoryMutation,
  prepareTransferMutation,
  type PreparedTransferMutation
} from './transfers.service';
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
  isTerminalWorkOrderStatus
} from './workOrderLifecycle.service';
import {
  assertWorkOrderRoutingLine
} from './stageRouting.service';
import {
  restoreReservationsForVoid
} from './inventoryReservation.service';
import * as movementPlanner from './inventoryMovementPlanner';
import * as replayEngine from './inventoryReplayEngine';
import * as statePolicy from './inventoryStatePolicy';
import * as eventFactory from './inventoryEventFactory';
import * as wipEngine from './wipAccountingEngine';
import * as projectionEngine from './inventoryProjectionEngine';
import * as lotTraceability from './lotTraceabilityEngine';
import {
  buildReportProductionPlan
} from '../domain/workOrders/reportProductionPlan';
import {
  assertReportProductionWarehouseSellableDefault,
  evaluateReportProductionPolicy
} from '../domain/workOrders/reportProductionPolicy';
import {
  executeWorkOrderBatchPosting
} from '../domain/workOrders/batchExecution';
import {
  planWorkOrderBatch
} from '../domain/workOrders/batchPlan';
import {
  evaluateWorkOrderBatchPolicy,
  type WorkOrderBatchPolicy
} from '../domain/workOrders/batchPolicy';
import {
  assertScrapReasonCode,
  assertVoidReason,
  hashNormalizedBatchRequest,
  normalizeBatchRequestPayload,
  normalizedOptionalIdempotencyKey,
  type NormalizedBatchConsumeLine,
  type NormalizedBatchProduceLine
} from './workOrderExecution.request';
import {
  compareProduceLineLockKey
} from './workOrderExecution.ordering';
import { mapExecution } from './workOrderExecution.response';
import { fetchWorkOrderIssue } from './workOrderIssuePost.workflow';

export { fetchWorkOrderIssue, postWorkOrderIssue } from './workOrderIssuePost.workflow';

// Disassembly/rework is modeled as work_orders.kind = 'disassembly' and posts issue/receive movements
// (never inventory_adjustments). External refs include work order ids for traceability.

type WorkOrderIssueCreateInput = z.infer<typeof workOrderIssueCreateSchema>;
type WorkOrderCompletionCreateInput = z.infer<typeof workOrderCompletionCreateSchema>;
type WorkOrderBatchInput = z.infer<typeof workOrderBatchSchema>;
type WorkOrderReportProductionInput = z.infer<typeof workOrderReportProductionSchema>;
type WorkOrderVoidReportProductionInput = z.infer<typeof workOrderVoidReportProductionSchema>;
type WorkOrderReportScrapInput = z.infer<typeof workOrderReportScrapSchema>;
type WorkOrderCompletionRecord = ReturnType<typeof mapExecution>;
type WorkOrderCompletionReplayResult = Awaited<ReturnType<typeof replayEngine.replayCompletion>> & {
  responseBody: WorkOrderCompletionRecord;
};
type RetryableSqlStateError = { retrySqlState?: string; code?: string };

const WIP_COST_METHOD = 'fifo';
const WORK_ORDER_POST_RETRY_OPTIONS = { isolationLevel: 'SERIALIZABLE' as const, retries: 8 };
const FORCED_LOT_LINK_FAILURE_KEYS = new Set<string>();

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

function workOrderRoutingContext(workOrder: WorkOrderRow) {
  return {
    kind: workOrder.kind,
    outputItemId: workOrder.output_item_id,
    bomId: workOrder.bom_id,
    defaultConsumeLocationId: workOrder.default_consume_location_id,
    defaultProduceLocationId: workOrder.default_produce_location_id,
    produceToLocationIdSnapshot: workOrder.produce_to_location_id_snapshot
  };
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

async function buildWorkOrderBatchReplayResult(params: {
  tenantId: string;
  workOrderId: string;
  executionId: string;
  issueMovementId: string;
  receiveMovementId: string;
  expectedIssueLineCount?: number;
  expectedReceiveLineCount?: number;
  expectedIssueDeterministicHash?: string | null;
  expectedReceiveDeterministicHash?: string | null;
  client: PoolClient;
  idempotencyKey?: string | null;
  preFetchIntegrityCheck: () => Promise<void>;
  fetchAggregateView: () => Promise<WorkOrderBatchResult | null>;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      {
        movementId: params.issueMovementId,
        expectedLineCount: params.expectedIssueLineCount,
        expectedDeterministicHash: params.expectedIssueDeterministicHash ?? null
      },
      {
        movementId: params.receiveMovementId,
        expectedLineCount: params.expectedReceiveLineCount,
        expectedDeterministicHash: params.expectedReceiveDeterministicHash ?? null
      }
    ],
    client: params.client,
    preFetchIntegrityCheck: params.preFetchIntegrityCheck,
    fetchAggregateView: params.fetchAggregateView,
    aggregateNotFoundError: new Error('WO_EXECUTION_NOT_FOUND'),
    authoritativeEvents: [
      eventFactory.buildInventoryMovementPostedEvent(params.issueMovementId, params.idempotencyKey ?? null),
      eventFactory.buildInventoryMovementPostedEvent(params.receiveMovementId, params.idempotencyKey ?? null),
      eventFactory.buildWorkOrderProductionReportedEvent({
        executionId: params.executionId,
        workOrderId: params.workOrderId,
        issueMovementId: params.issueMovementId,
        receiveMovementId: params.receiveMovementId,
        producerIdempotencyKey: params.idempotencyKey ?? null
      })
    ]
  });
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

type ManufacturingMutationState =
  | 'planned_issue'
  | 'posted_issue'
  | 'planned_completion'
  | 'reported_production'
  | 'posted_completion'
  | 'reversal';

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

type NegativeOverrideContext = {
  actor?: { type: 'user' | 'system'; id?: string | null; role?: string | null };
  overrideRequested?: boolean;
  overrideReason?: string | null;
};

type WorkOrderRow = {
  id: string;
  work_order_number: string;
  number: string | null;
  status: string;
  kind: string;
  bom_id: string | null;
  bom_version_id: string | null;
  routing_id: string | null;
  produce_to_location_id_snapshot: string | null;
  output_item_id: string;
  output_uom: string;
  quantity_planned: string | number;
  quantity_completed: string | number | null;
  quantity_scrapped: string | number | null;
  default_consume_location_id: string | null;
  default_produce_location_id: string | null;
  completed_at: string | null;
  updated_at: string;
};

type WorkOrderExecutionRow = {
  id: string;
  work_order_id: string;
  occurred_at: string;
  status: string;
  consumption_movement_id: string | null;
  production_movement_id: string | null;
  production_batch_id: string | null;
  output_lot_id: string | null;
  wip_total_cost: string | number | null;
  wip_unit_cost: string | number | null;
  wip_quantity_canonical: string | number | null;
  wip_cost_method: string | null;
  wip_costed_at: string | null;
  notes: string | null;
  created_at: string;
};

type WorkOrderExecutionLineRow = {
  id: string;
  work_order_execution_id: string;
  line_type: string;
  item_id: string;
  uom: string;
  quantity: string | number;
  pack_size: string | number | null;
  from_location_id: string | null;
  to_location_id: string | null;
  reason_code: string | null;
  notes: string | null;
  created_at: string;
};

type WorkOrderIssuedTotalRow = {
  component_item_id: string;
  component_item_sku: string;
  component_item_name: string;
  uom: string;
  qty: string | number;
};

type WorkOrderCompletedTotalRow = {
  item_id: string;
  item_sku: string;
  item_name: string;
  uom: string;
  qty: string | number;
};

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

export async function verifyWorkOrderWipIntegrityForClose(
  tenantId: string,
  workOrderId: string,
  client?: PoolClient
) {
  if (client) {
    await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
    return;
  }
  await withTransaction(async (tx) => {
    await wipEngine.verifyWipIntegrity(tx, tenantId, workOrderId);
  });
}

export async function createWorkOrderIssue(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderIssueCreateInput,
  options?: { idempotencyKey?: string | null }
) {
  const lineNumbers = new Set<number>();
  const normalizedLines = data.lines.map((line, index) => {
    const lineNumber = line.lineNumber ?? index + 1;
    if (lineNumbers.has(lineNumber)) {
      throw new Error('WO_ISSUE_DUPLICATE_LINE');
    }
    const quantityIssued = toNumber(line.quantityIssued);
    lineNumbers.add(lineNumber);
    return {
      lineNumber,
      componentItemId: line.componentItemId,
      fromLocationId: line.fromLocationId,
      uom: line.uom,
      quantityIssued,
      reasonCode: line.reasonCode ?? null,
      notes: line.notes ?? null
    };
  });

  const issueId = uuidv4();
  const now = new Date();
  const idempotencyKey = options?.idempotencyKey ?? null;

  return withTransaction(async (client) => {
    if (idempotencyKey) {
      const existing = await client.query(
        `SELECT id FROM work_order_material_issues WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey]
      );
      if ((existing.rowCount ?? 0) > 0) {
        return fetchWorkOrderIssue(tenantId, workOrderId, existing.rows[0].id, client);
      }
    }
    const workOrder = await fetchWorkOrderById(tenantId, workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    if (isTerminalWorkOrderStatus(workOrder.status)) {
      throw new Error('WO_INVALID_STATE');
    }

    if (workOrder.kind !== 'disassembly') {
      for (const line of normalizedLines) {
        await assertWorkOrderRoutingLine({
          tenantId,
          context: workOrderRoutingContext(workOrder),
          componentItemId: line.componentItemId,
          consumeLocationId: line.fromLocationId,
          client
        });
      }
    }

    await client.query(
      `INSERT INTO work_order_material_issues (
          id, tenant_id, work_order_id, status, occurred_at, inventory_movement_id, notes, idempotency_key, created_at, updated_at
       ) VALUES ($1, $2, $3, 'draft', $4, NULL, $5, $6, $7, $7)`,
      [issueId, tenantId, workOrderId, new Date(data.occurredAt), data.notes ?? null, idempotencyKey, now]
    );

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO work_order_material_issue_lines (
            id, tenant_id, work_order_material_issue_id, line_number, component_item_id, uom, quantity_issued, from_location_id, reason_code, notes, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          uuidv4(),
          tenantId,
          issueId,
          line.lineNumber,
          line.componentItemId,
          line.uom,
          line.quantityIssued,
          line.fromLocationId,
          line.reasonCode,
          line.notes,
          now
        ]
      );
    }

    const issue = await fetchWorkOrderIssue(tenantId, workOrderId, issueId, client);
    if (!issue) {
      throw new Error('WO_ISSUE_NOT_FOUND_AFTER_CREATE');
    }
    return issue;
  });
}

export async function createWorkOrderCompletion(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderCompletionCreateInput,
  options?: { idempotencyKey?: string | null }
) {
  const executionId = uuidv4();
  const now = new Date();
  const idempotencyKey = options?.idempotencyKey ?? null;
  const normalizedLines = data.lines.map((line) => ({
    ...line,
    uom: line.uom,
    quantityCompleted: toNumber(line.quantityCompleted)
  }));

  return withTransaction(async (client) => {
    if (idempotencyKey) {
      const existing = await client.query(
        `SELECT id FROM work_order_executions WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey]
      );
      if ((existing.rowCount ?? 0) > 0) {
        return fetchWorkOrderCompletion(tenantId, workOrderId, existing.rows[0].id, client);
      }
    }
    const workOrder = await fetchWorkOrderById(tenantId, workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    if (isTerminalWorkOrderStatus(workOrder.status)) {
      throw new Error('WO_INVALID_STATE');
    }

    if (workOrder.kind !== 'disassembly') {
      for (const line of normalizedLines) {
        await assertWorkOrderRoutingLine({
          tenantId,
          context: workOrderRoutingContext(workOrder),
          produceLocationId: line.toLocationId,
          client
        });
      }
    }

    await client.query(
      `INSERT INTO work_order_executions (
          id, tenant_id, work_order_id, occurred_at, status, consumption_movement_id, production_movement_id, notes, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, 'draft', NULL, NULL, $5, $6, $7)`,
      [executionId, tenantId, workOrderId, new Date(data.occurredAt), data.notes ?? null, idempotencyKey, now]
    );

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO work_order_execution_lines (
            id, tenant_id, work_order_execution_id, line_type, item_id, uom, quantity, pack_size, from_location_id, to_location_id, reason_code, notes, created_at
         ) VALUES ($1, $2, $3, 'produce', $4, $5, $6, $7, NULL, $8, $9, $10, $11)`,
        [
          uuidv4(),
          tenantId,
          executionId,
          line.outputItemId,
          line.uom,
          line.quantityCompleted,
          line.packSize ?? null,
          line.toLocationId,
          line.reasonCode ?? null,
          line.notes ?? null,
          now
        ]
      );
    }

    const created = await fetchWorkOrderCompletion(tenantId, workOrderId, executionId, client);
    if (!created) {
      throw new Error('WO_COMPLETION_NOT_FOUND_AFTER_CREATE');
    }
    return created;
  });
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
    execute: async ({ client, lockContext }) => {
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
        const replay = await replayEngine.replayCompletion({
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
        const replay = await replayEngine.replayCompletion({
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

export async function getWorkOrderExecutionSummary(tenantId: string, workOrderId: string) {
  const workOrderResult = await query<WorkOrderRow>('SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2', [
    workOrderId,
    tenantId
  ]);
  if (workOrderResult.rowCount === 0) {
    return null;
  }
  const workOrder = workOrderResult.rows[0];

  const issuedRows = await query<WorkOrderIssuedTotalRow>(
    `SELECT l.component_item_id,
            i.sku AS component_item_sku,
            i.name AS component_item_name,
            l.uom,
            SUM(l.quantity_issued) AS qty
       FROM work_order_material_issue_lines l
       JOIN work_order_material_issues h ON h.id = l.work_order_material_issue_id
       JOIN items i ON i.id = l.component_item_id AND i.tenant_id = h.tenant_id
      WHERE h.work_order_id = $1
        AND h.status = 'posted'
        AND h.tenant_id = $2
        AND l.tenant_id = $2
      GROUP BY l.component_item_id, i.sku, i.name, l.uom`,
    [workOrderId, tenantId]
  );

  const producedRows = await query<WorkOrderCompletedTotalRow>(
    `SELECT l.item_id,
            i.sku AS item_sku,
            i.name AS item_name,
            l.uom,
            SUM(l.quantity) AS qty
       FROM work_order_execution_lines l
       JOIN work_order_executions h ON h.id = l.work_order_execution_id
       JOIN items i ON i.id = l.item_id AND i.tenant_id = h.tenant_id
      WHERE h.work_order_id = $1
        AND h.status = 'posted'
        AND l.line_type = 'produce'
        AND h.tenant_id = $2
        AND l.tenant_id = $2
      GROUP BY l.item_id, i.sku, i.name, l.uom`,
    [workOrderId, tenantId]
  );

  const planned = roundQuantity(toNumber(workOrder.quantity_planned));
  const completed = roundQuantity(toNumber(workOrder.quantity_completed ?? 0));
  const scrapped = roundQuantity(toNumber(workOrder.quantity_scrapped ?? 0));

  const bom = workOrder.bom_id ? await fetchBomById(tenantId, workOrder.bom_id) : null;

  return {
    workOrder: {
      id: workOrder.id,
      status: workOrder.status,
      kind: workOrder.kind,
      bomId: workOrder.bom_id,
      bomVersionId: workOrder.bom_version_id,
      outputItemId: workOrder.output_item_id,
      outputUom: workOrder.output_uom,
      quantityPlanned: planned,
      quantityCompleted: completed,
      quantityScrapped: scrapped,
      completedAt: workOrder.completed_at
    },
    issuedTotals: issuedRows.rows.map((row) => ({
      componentItemId: row.component_item_id,
      componentItemSku: row.component_item_sku,
      componentItemName: row.component_item_name,
      uom: row.uom,
      quantityIssued: roundQuantity(toNumber(row.qty))
    })),
    completedTotals: producedRows.rows.map((row) => ({
      outputItemId: row.item_id,
      outputItemSku: row.item_sku,
      outputItemName: row.item_name,
      uom: row.uom,
      quantityCompleted: roundQuantity(toNumber(row.qty))
    })),
    remainingToComplete: roundQuantity(Math.max(0, planned - completed - scrapped)),
    bom
  };
}

export type WorkOrderProductionReportResult = {
  workOrderId: string;
  productionReportId: string;
  componentIssueMovementId: string;
  productionReceiptMovementId: string;
  idempotencyKey: string | null;
  replayed: boolean;
  lotTracking?: {
    outputLotId: string;
    outputLotCode: string;
    inputLotCount: number;
  };
};

export type WorkOrderVoidReportResult = {
  workOrderId: string;
  workOrderExecutionId: string;
  componentReturnMovementId: string;
  outputReversalMovementId: string;
  idempotencyKey: string | null;
  replayed: boolean;
};

export type WorkOrderScrapReportResult = {
  workOrderId: string;
  workOrderExecutionId: string;
  scrapMovementId: string;
  itemId: string;
  quantity: number;
  uom: string;
  idempotencyKey: string | null;
  replayed: boolean;
};

type WorkOrderBatchResult = {
  workOrderId: string;
  executionId: string;
  issueMovementId: string;
  receiveMovementId: string;
  quantityCompleted: number;
  workOrderStatus: string;
  idempotencyKey: string | null;
  replayed: boolean;
};

const WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE = 'work_order_batch_void_output';
const WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE = 'work_order_batch_void_components';
const WORK_ORDER_SCRAP_SOURCE_TYPE = 'work_order_scrap';

type LockedExecutionRow = {
  id: string;
  work_order_id: string;
  status: string;
  occurred_at: string;
  consumption_movement_id: string | null;
  production_movement_id: string | null;
};

type MovementLineScopeRow = {
  item_id: string;
  location_id: string;
  warehouse_id: string | null;
  qty_canonical: string | number;
  balance_uom: string;
  unit_cost: string | number | null;
  extended_cost: string | number | null;
};

type ExistingVoidMovementsRow = {
  id: string;
  source_type: string;
  status: string;
};

function shouldSimulateLotLinkFailureOnce(idempotencyKey: string | null, replayed: boolean) {
  if (replayed || !idempotencyKey) return false;
  // Guarded by an explicit test-only key marker to avoid env-coupled flakiness.
  if (!idempotencyKey.includes(':simulate-lot-link-failure')) return false;
  if (FORCED_LOT_LINK_FAILURE_KEYS.has(idempotencyKey)) return false;
  FORCED_LOT_LINK_FAILURE_KEYS.add(idempotencyKey);
  return true;
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

export async function reportWorkOrderProduction(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderReportProductionInput,
  context: NegativeOverrideContext = {},
  options?: { idempotencyKey?: string | null }
): Promise<WorkOrderProductionReportResult> {
  const policy = await evaluateReportProductionPolicy({
    tenantId,
    workOrderId,
    data,
    options
  });
  const plan = await buildReportProductionPlan({
    tenantId,
    workOrderId,
    policy
  });
  const shouldBypassWarehouseSellableGuard = policy.reportIdempotencyKey
    ? await hasExistingReportProductionIdempotencyClaim(tenantId, policy.reportIdempotencyKey)
    : false;
  if (!shouldBypassWarehouseSellableGuard) {
    await assertReportProductionWarehouseSellableDefault({
      tenantId,
      workOrderId,
      warehouseId: data.warehouseId ?? null
    });
  }

  const batchResult = await recordWorkOrderBatch(
    tenantId,
    workOrderId,
    {
      occurredAt: policy.occurredAt.toISOString(),
      notes: policy.notes ?? undefined,
      consumeLines: [...plan.consumeLines],
      produceLines: [...plan.produceLines]
    },
    context,
    {
      idempotencyKey: policy.reportIdempotencyKey,
      idempotencyEndpoint: IDEMPOTENCY_ENDPOINTS.WORK_ORDER_REPORT_PRODUCTION,
      traceability: plan.traceability
    }
  );

  if (shouldSimulateLotLinkFailureOnce(policy.reportIdempotencyKey, batchResult.replayed)) {
    throw domainError('WO_REPORT_LOT_LINK_INCOMPLETE', {
      reason: 'simulated_failure_after_post_before_lot_link',
      workOrderId,
      productionReportId: batchResult.executionId
    });
  }
  const finalized = await withTransaction((client) => replayEngine.finalizeBatchExecutionTraceability({
    tenantId,
    workOrderId,
    executionId: batchResult.executionId,
    issueMovementId: batchResult.issueMovementId,
    receiveMovementId: batchResult.receiveMovementId,
    client,
    traceability: {
      outputItemId: plan.traceability.outputItemId,
      outputQty: plan.traceability.outputQty,
      outputUom: plan.traceability.outputUom,
      outputLotId: plan.traceability.outputLotId ?? null,
      outputLotCode: plan.traceability.outputLotCode ?? null,
      inputLots: plan.traceability.inputLots ? [...plan.traceability.inputLots] : []
    }
  }));

  return {
    workOrderId,
    productionReportId: batchResult.executionId,
    componentIssueMovementId: finalized.classification.authoritativeMovementIds.issueMovementId ?? batchResult.issueMovementId,
    productionReceiptMovementId: finalized.classification.authoritativeMovementIds.receiveMovementId ?? batchResult.receiveMovementId,
    idempotencyKey: batchResult.idempotencyKey ?? policy.reportIdempotencyKey,
    replayed: batchResult.replayed,
    lotTracking: finalized.lotTracking
  };
}

async function hasExistingReportProductionIdempotencyClaim(tenantId: string, idempotencyKey: string) {
  const existing = await query<{ key: string }>(
    `SELECT key
       FROM idempotency_keys
      WHERE tenant_id = $1
        AND key = $2
      LIMIT 1`,
    [tenantId, idempotencyKey]
  );
  return (existing.rowCount ?? 0) > 0;
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

export async function reportWorkOrderScrap(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderReportScrapInput,
  actor: { type: 'user' | 'system'; id?: string | null },
  options?: { idempotencyKey?: string | null }
): Promise<WorkOrderScrapReportResult> {
  const occurredAt = data.occurredAt ? new Date(data.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error('WO_SCRAP_INVALID_OCCURRED_AT');
  }
  const quantity = roundQuantity(toNumber(data.quantity));
  if (!(quantity > 0)) {
    throw new Error('WO_SCRAP_INVALID_QTY');
  }
  const reasonCode = assertScrapReasonCode(data.reasonCode);
  const idempotencyKey = normalizedOptionalIdempotencyKey(options?.idempotencyKey ?? data.idempotencyKey ?? null);
  const scrapSourceId = idempotencyKey
    ? `idempotency:${idempotencyKey}`
    : `execution:${data.workOrderExecutionId}:scrap:${uuidv4()}`;
  const occurredAtForHash = data.occurredAt ? new Date(data.occurredAt).toISOString() : null;
  const idempotencyRequestHash = idempotencyKey
    ? hashTransactionalIdempotencyRequest({
      method: 'POST',
      endpoint: IDEMPOTENCY_ENDPOINTS.WORK_ORDER_REPORT_SCRAP,
      body: {
        workOrderId,
        workOrderExecutionId: data.workOrderExecutionId,
        outputItemId: data.outputItemId ?? null,
        quantity,
        uom: data.uom,
        reasonCode,
        notes: data.notes ?? null,
        occurredAt: occurredAtForHash
      }
    })
    : null;

  let execution: LockedExecutionRow | null = null;
  let itemId = '';
  let sourceLocationId = '';
  let warehouseId = '';
  let scrapLocationId = '';
  let preparedTransfer: PreparedTransferMutation | null = null;

  return runInventoryCommand<WorkOrderScrapReportResult>({
    tenantId,
    endpoint: IDEMPOTENCY_ENDPOINTS.WORK_ORDER_REPORT_SCRAP,
    operation: 'work_order_report_scrap',
    idempotencyKey,
    requestHash: idempotencyRequestHash,
    retryOptions: WORK_ORDER_POST_RETRY_OPTIONS,
    onReplay: async ({ client, responseBody }) => {
      await replayEngine.replayTransferBackedScrap({
        tenantId,
        workOrderId,
        workOrderExecutionId: responseBody.workOrderExecutionId,
        itemId: responseBody.itemId,
        quantity: responseBody.quantity,
        uom: responseBody.uom,
        scrapMovementId: responseBody.scrapMovementId,
        idempotencyKey,
        client
      });
      return {
        ...responseBody,
        replayed: true
      };
    },
    lockTargets: async (client) => {
      execution = null;
      itemId = '';
      sourceLocationId = '';
      warehouseId = '';
      scrapLocationId = '';
      preparedTransfer = null;

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
        throw new Error('WO_SCRAP_EXECUTION_NOT_FOUND');
      }
      execution = executionRes.rows[0];
      assertSameWorkOrderExecution(workOrderId, execution);
      if (execution.status !== 'posted' || !execution.production_movement_id) {
        throw new Error('WO_SCRAP_EXECUTION_NOT_POSTED');
      }

      const outputItemRes = await client.query<{ output_item_id: string }>(
        `SELECT output_item_id
           FROM work_orders
          WHERE tenant_id = $1
            AND id = $2`,
        [tenantId, workOrderId]
      );
      if (outputItemRes.rowCount === 0) {
        throw new Error('WO_NOT_FOUND');
      }
      const outputItemId = outputItemRes.rows[0].output_item_id;
      itemId = data.outputItemId ?? outputItemId;
      if (itemId !== outputItemId) {
        throw new Error('WO_SCRAP_OUTPUT_ITEM_MISMATCH');
      }

      const qaSourceRows = await client.query<{
        location_id: string;
        warehouse_id: string | null;
        role: string | null;
        total_qty: string | number;
      }>(
        `SELECT iml.location_id,
                l.warehouse_id,
                l.role,
                SUM(COALESCE(iml.quantity_delta_canonical, iml.quantity_delta))::numeric AS total_qty
           FROM inventory_movement_lines iml
           JOIN locations l
             ON l.id = iml.location_id
            AND l.tenant_id = iml.tenant_id
          WHERE iml.tenant_id = $1
            AND iml.movement_id = $2
            AND iml.item_id = $3
            AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
          GROUP BY iml.location_id, l.warehouse_id, l.role
         HAVING l.role = 'QA'`,
        [tenantId, execution.production_movement_id, itemId]
      );
      if (qaSourceRows.rowCount !== 1) {
        throw new Error('WO_SCRAP_QA_SOURCE_AMBIGUOUS');
      }
      const qaSource = qaSourceRows.rows[0];
      if (!qaSource.warehouse_id) {
        throw new Error('WO_SCRAP_QA_SOURCE_WAREHOUSE_MISSING');
      }
      sourceLocationId = qaSource.location_id;
      warehouseId = qaSource.warehouse_id;
      const resolvedScrapLocationId = await getWarehouseDefaultLocationId(
        tenantId,
        warehouseId,
        'SCRAP',
        client
      );
      if (!resolvedScrapLocationId) {
        throw new Error('WO_SCRAP_LOCATION_REQUIRED');
      }
      scrapLocationId = resolvedScrapLocationId;
      statePolicy.assertInventoryStateTransition({
        flow: 'scrap',
        currentState: 'QA',
        targetState: 'SCRAP',
        workOrderId,
        executionOrDocumentId: execution.id
      });

      const availableRes = await client.query<{ qty: string | number }>(
        `SELECT COALESCE(SUM(remaining_quantity), 0)::numeric AS qty
           FROM inventory_cost_layers
          WHERE tenant_id = $1
            AND movement_id = $2
            AND source_type = 'production'
            AND item_id = $3
            AND location_id = $4
            AND voided_at IS NULL`,
        [tenantId, execution.production_movement_id, itemId, sourceLocationId]
      );
      const availableQty = roundQuantity(toNumber(availableRes.rows[0]?.qty ?? 0));
      if (quantity - availableQty > 1e-6) {
        throw domainError('WO_SCRAP_EXCEEDS_EXECUTION_QA_AVAILABLE', {
          workOrderExecutionId: execution.id,
          itemId,
          requestedQty: quantity,
          availableQty
        });
      }

      preparedTransfer = await prepareTransferMutation(
        {
          tenantId,
          sourceLocationId,
          destinationLocationId: scrapLocationId,
          warehouseId,
          itemId,
          quantity,
          uom: data.uom,
          sourceType: WORK_ORDER_SCRAP_SOURCE_TYPE,
          sourceId: scrapSourceId,
          movementType: 'transfer',
          reasonCode,
          notes: data.notes ?? `Work-order scrap for execution ${execution.id}`,
          occurredAt,
          actorId: actor.id ?? null,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:transfer` : null
        },
        client
      );
      return buildTransferLockTargets(preparedTransfer);
    },
    execute: async ({ client, lockContext }) => {
      if (!execution || !preparedTransfer || !itemId || !sourceLocationId || !scrapLocationId || !warehouseId) {
        throw new Error('WO_SCRAP_PREPARE_REQUIRED');
      }
      const plannedScrapMovement = movementPlanner.buildScrapMovement({
        preparedTransfer
      });
      const transferExecution = await executeTransferInventoryMutation(
        plannedScrapMovement.preparedTransfer,
        client,
        lockContext
      );
      const now = new Date();
      const projectionOps = [
        ...transferExecution.projectionOps,
        ...projectionEngine.buildScrapProjectionOps({
          tenantId,
          workOrderId,
          quantity,
          now,
          created: transferExecution.result.created
        })
      ];
      return {
        responseBody: {
          workOrderId,
          workOrderExecutionId: execution.id,
          scrapMovementId: transferExecution.result.movementId,
          itemId,
          quantity,
          uom: data.uom,
          idempotencyKey,
          replayed: !transferExecution.result.created
        },
        responseStatus: transferExecution.result.created ? 201 : 200,
        events: transferExecution.events,
        projectionOps
      };
    }
  });
}

export async function recordWorkOrderBatch(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderBatchInput,
  context: NegativeOverrideContext = {},
  options?: {
    idempotencyKey?: string | null;
    idempotencyEndpoint?: string;
    traceability?: {
      outputItemId: string;
      outputQty: number;
      outputUom: string;
      outputLotId?: string | null;
      outputLotCode?: string | null;
      productionBatchId?: string | null;
      inputLots?: ReadonlyArray<lotTraceability.WorkOrderInputLotLink>;
      workOrderNumber: string;
      occurredAt: Date;
    };
  }
): Promise<WorkOrderBatchResult> {
  const batchIdempotencyKey = options?.idempotencyKey?.trim() ? options.idempotencyKey.trim() : null;
  const idempotencyEndpoint = options?.idempotencyEndpoint ?? IDEMPOTENCY_ENDPOINTS.WORK_ORDER_RECORD_BATCH;
  const normalizedConsumes: NormalizedBatchConsumeLine[] = data.consumeLines.map((line) => {
    const quantity = toNumber(line.quantity);
    if (quantity <= 0) {
      throw new Error('WO_BATCH_INVALID_CONSUME_QTY');
    }
    return {
      componentItemId: line.componentItemId,
      fromLocationId: line.fromLocationId,
      quantity,
      uom: line.uom,
      reasonCode: line.reasonCode ?? null,
      notes: line.notes ?? null
    };
  });
  const normalizedProduces: NormalizedBatchProduceLine[] = data.produceLines.map((line) => {
    const quantity = toNumber(line.quantity);
    if (quantity <= 0) {
      throw new Error('WO_BATCH_INVALID_PRODUCE_QTY');
    }
    return {
      outputItemId: line.outputItemId,
      toLocationId: line.toLocationId,
      quantity,
      uom: line.uom,
      reasonCode: line.reasonCode ?? null,
      packSize: line.packSize ?? null,
      notes: line.notes ?? null
    };
  });
  const occurredAt = new Date(data.occurredAt);
  const normalizedRequestPayload = normalizeBatchRequestPayload({
    workOrderId,
    occurredAt,
    notes: data.notes ?? null,
    overrideNegative: data.overrideNegative,
    overrideReason: data.overrideReason ?? null,
    consumeLines: normalizedConsumes,
    produceLines: normalizedProduces
  });
  const requestHash = hashNormalizedBatchRequest(normalizedRequestPayload);
  const transactionalRequestHash = batchIdempotencyKey
    ? hashTransactionalIdempotencyRequest({
      method: 'POST',
      endpoint: idempotencyEndpoint,
      body: normalizedRequestPayload
    })
    : null;
  let batchPolicy: WorkOrderBatchPolicy | null = null;

  return runInventoryCommand<WorkOrderBatchResult>({
    tenantId,
    endpoint: idempotencyEndpoint,
    operation: 'work_order_batch_post',
    idempotencyKey: batchIdempotencyKey,
    requestHash: transactionalRequestHash,
    retryOptions: WORK_ORDER_POST_RETRY_OPTIONS,
    onReplay: async ({ client, responseBody }) => {
      const replay = await replayEngine.replayBatch({
          tenantId,
          workOrderId: responseBody.workOrderId,
          executionId: responseBody.executionId,
          issueMovementId: responseBody.issueMovementId,
          receiveMovementId: responseBody.receiveMovementId,
          expectedIssueLineCount: normalizedConsumes.length,
          expectedReceiveLineCount: normalizedProduces.length,
          client,
          idempotencyKey: batchIdempotencyKey,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, responseBody.workOrderId);
          },
          fetchAggregateView: async () => {
            const res = await client.query<{
              execution_id: string;
              work_order_id: string;
              quantity_completed: string | number | null;
              work_order_status: string;
            }>(
              `SELECT e.id AS execution_id,
                      e.work_order_id,
                      w.quantity_completed,
                      w.status AS work_order_status
                 FROM work_order_executions e
                 JOIN work_orders w
                   ON w.id = e.work_order_id
                  AND w.tenant_id = e.tenant_id
                WHERE e.tenant_id = $1
                  AND e.id = $2
                  AND e.work_order_id = $3
                FOR UPDATE OF e`,
              [tenantId, responseBody.executionId, responseBody.workOrderId]
            );
            const row = res.rows[0];
            if (!row) {
              return null;
            }
            return {
              workOrderId: row.work_order_id,
              executionId: row.execution_id,
              issueMovementId: responseBody.issueMovementId,
              receiveMovementId: responseBody.receiveMovementId,
              quantityCompleted: roundQuantity(toNumber(row.quantity_completed ?? 0)),
              workOrderStatus: row.work_order_status,
              idempotencyKey: batchIdempotencyKey,
              replayed: true
            };
          }
        });
      return replay.responseBody as WorkOrderBatchResult;
    },
    lockTargets: async (client) => {
      batchPolicy = await evaluateWorkOrderBatchPolicy({
        tenantId,
        workOrderId,
        batchIdempotencyKey,
        requestHash,
        normalizedConsumes,
        normalizedProduces,
        client
      });
      return batchPolicy.existingBatchReplay ? [] : [...batchPolicy.lockTargets];
    },
    execute: async ({ client }) => {
      if (!batchPolicy) {
        throw new Error('WO_NOT_FOUND');
      }
      if (batchPolicy.existingBatchReplay) {
        const replay = await replayEngine.replayBatch({
          tenantId,
          workOrderId: batchPolicy.existingBatchReplay.workOrderId,
          executionId: batchPolicy.existingBatchReplay.executionId,
          issueMovementId: batchPolicy.existingBatchReplay.issueMovementId,
          receiveMovementId: batchPolicy.existingBatchReplay.receiveMovementId,
          expectedIssueLineCount: normalizedConsumes.length,
          expectedReceiveLineCount: normalizedProduces.length,
          client,
          idempotencyKey: batchIdempotencyKey,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, batchPolicy!.existingBatchReplay!.workOrderId);
          },
          fetchAggregateView: async () => ({
            workOrderId: batchPolicy!.existingBatchReplay!.workOrderId,
            executionId: batchPolicy!.existingBatchReplay!.executionId,
            issueMovementId: batchPolicy!.existingBatchReplay!.issueMovementId,
            receiveMovementId: batchPolicy!.existingBatchReplay!.receiveMovementId,
            quantityCompleted: batchPolicy!.existingBatchReplay!.quantityCompleted,
            workOrderStatus: batchPolicy!.existingBatchReplay!.workOrderStatus,
            idempotencyKey: batchIdempotencyKey,
            replayed: true
          })
        });
        return {
          ...replay,
          responseBody: replay.responseBody as WorkOrderBatchResult
        };
      }
      const batchPlan = await planWorkOrderBatch({
        tenantId,
        workOrderId,
        policy: batchPolicy,
        client
      });
      return executeWorkOrderBatchPosting({
        tenantId,
        workOrderId,
        policy: batchPolicy,
        plan: batchPlan,
        occurredAt,
        notes: data.notes ?? null,
        context,
        batchIdempotencyKey,
        requestHash,
        traceability: options?.traceability ?? null,
        client
      });
    }
  });
}
