import type { PoolClient } from 'pg';
import { roundQuantity, toNumber } from '../lib/numbers';
import {
  buildPostedDocumentReplayResult,
  buildReplayCorruptionError
} from '../modules/platform/application/inventoryMutationSupport';
import { buildTransferReplayResult } from './transfers.service';
import { getWarehouseDefaultLocationId } from './warehouseDefaults.service';
import {
  buildInventoryMovementPostedEvent,
  buildWorkOrderCompletionPostedEvent,
  buildWorkOrderIssuePostedEvent,
  buildWorkOrderProductionReportedEvent,
  buildWorkOrderProductionReversedEvent
} from './inventoryEventFactory';

function domainError(code: string, details?: Record<string, unknown>) {
  const error = new Error(code) as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = code;
  error.details = details;
  return error;
}

export async function ensurePostedMovementReady(
  client: PoolClient,
  tenantId: string,
  movementId: string
) {
  const movementRes = await client.query<{ status: string }>(
    `SELECT status
       FROM inventory_movements
      WHERE id = $1
        AND tenant_id = $2
      FOR UPDATE`,
    [movementId, tenantId]
  );
  if (movementRes.rowCount === 0) {
    throw new Error('WO_POSTING_MOVEMENT_MISSING');
  }
  if (movementRes.rows[0].status !== 'posted') {
    throw new Error('WO_POSTING_IDEMPOTENCY_CONFLICT');
  }
  const lineRes = await client.query(
    `SELECT 1
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
      LIMIT 1`,
    [tenantId, movementId]
  );
  if (lineRes.rowCount === 0) {
    throw new Error('WO_POSTING_IDEMPOTENCY_INCOMPLETE');
  }
}

export async function findPostedBatchByIdempotencyKey(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string,
  expectedRequestHash: string
) {
  const existing = await client.query<{
    id: string;
    work_order_id: string;
    status: string;
    consumption_movement_id: string | null;
    production_movement_id: string | null;
    quantity_completed: string | number | null;
    work_order_status: string;
    idempotency_request_hash: string | null;
  }>(
    `SELECT e.id,
            e.work_order_id,
            e.status,
            e.consumption_movement_id,
            e.production_movement_id,
            w.quantity_completed,
            w.status AS work_order_status,
            e.idempotency_request_hash
       FROM work_order_executions e
       JOIN work_orders w
         ON w.id = e.work_order_id
        AND w.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1
        AND e.idempotency_key = $2
      FOR UPDATE OF e`,
    [tenantId, idempotencyKey]
  );
  if (existing.rowCount === 0) {
    return null;
  }
  const row = existing.rows[0];
  if (!row.idempotency_request_hash) {
    throw domainError('WO_POSTING_IDEMPOTENCY_CONFLICT', {
      reason: 'missing_request_hash',
      executionId: row.id
    });
  }
  if (row.idempotency_request_hash !== expectedRequestHash) {
    throw domainError('WO_POSTING_IDEMPOTENCY_CONFLICT', {
      reason: 'request_hash_mismatch',
      executionId: row.id
    });
  }
  if (row.status !== 'posted') {
    throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
      reason: 'execution_not_posted',
      missingExecutionIds: [row.id],
      hint: 'Retry with the same Idempotency-Key or contact admin'
    });
  }
  if (!row.consumption_movement_id || !row.production_movement_id) {
    throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
      reason: 'missing_execution_movements',
      missingExecutionIds: [row.id],
      hint: 'Retry with the same Idempotency-Key or contact admin'
    });
  }
  try {
    await ensurePostedMovementReady(client, tenantId, row.consumption_movement_id);
    await ensurePostedMovementReady(client, tenantId, row.production_movement_id);
  } catch (error: any) {
    if (
      error?.message === 'WO_POSTING_MOVEMENT_MISSING' ||
      error?.message === 'WO_POSTING_IDEMPOTENCY_INCOMPLETE'
    ) {
      throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
        reason: 'movement_not_ready',
        missingExecutionIds: [row.id],
        hint: 'Retry with the same Idempotency-Key or contact admin'
      });
    }
    throw error;
  }
  return {
    executionId: row.id,
    workOrderId: row.work_order_id,
    issueMovementId: row.consumption_movement_id,
    receiveMovementId: row.production_movement_id,
    quantityCompleted: roundQuantity(toNumber(row.quantity_completed ?? 0)),
    workOrderStatus: row.work_order_status
  };
}

export async function replayIssue(params: {
  tenantId: string;
  workOrderId: string;
  issueId: string;
  movementId: string;
  expectedLineCount?: number;
  expectedDeterministicHash?: string | null;
  client: PoolClient;
  idempotencyKey?: string | null;
  preFetchIntegrityCheck?: () => Promise<void>;
  fetchAggregateView: () => Promise<unknown | null>;
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
    aggregateNotFoundError: new Error('WO_ISSUE_NOT_FOUND'),
    authoritativeEvents: [
      buildInventoryMovementPostedEvent(params.movementId, params.idempotencyKey ?? null),
      buildWorkOrderIssuePostedEvent({
        issueId: params.issueId,
        workOrderId: params.workOrderId,
        movementId: params.movementId,
        producerIdempotencyKey: params.idempotencyKey ?? null
      })
    ]
  });
}

export async function replayCompletion(params: {
  tenantId: string;
  workOrderId: string;
  completionId: string;
  movementId: string;
  expectedLineCount?: number;
  expectedDeterministicHash?: string | null;
  client: PoolClient;
  idempotencyKey?: string | null;
  preFetchIntegrityCheck: () => Promise<void>;
  fetchAggregateView: () => Promise<unknown | null>;
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
      buildInventoryMovementPostedEvent(params.movementId, params.idempotencyKey ?? null),
      buildWorkOrderCompletionPostedEvent({
        executionId: params.completionId,
        workOrderId: params.workOrderId,
        movementId: params.movementId,
        producerIdempotencyKey: params.idempotencyKey ?? null
      })
    ]
  });
}

export async function replayBatch(params: {
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
  fetchAggregateView: () => Promise<unknown | null>;
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
      buildInventoryMovementPostedEvent(params.issueMovementId, params.idempotencyKey ?? null),
      buildInventoryMovementPostedEvent(params.receiveMovementId, params.idempotencyKey ?? null),
      buildWorkOrderProductionReportedEvent({
        executionId: params.executionId,
        workOrderId: params.workOrderId,
        issueMovementId: params.issueMovementId,
        receiveMovementId: params.receiveMovementId,
        producerIdempotencyKey: params.idempotencyKey ?? null
      })
    ]
  });
}

export async function replayVoid(params: {
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
  fetchAggregateView: () => Promise<unknown | null>;
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
      buildInventoryMovementPostedEvent(params.componentReturnMovementId, params.idempotencyKey ?? null),
      buildInventoryMovementPostedEvent(params.outputReversalMovementId, params.idempotencyKey ?? null),
      buildWorkOrderProductionReversedEvent({
        executionId: params.executionId,
        workOrderId: params.workOrderId,
        componentReturnMovementId: params.componentReturnMovementId,
        outputReversalMovementId: params.outputReversalMovementId,
        producerIdempotencyKey: params.idempotencyKey ?? null
      })
    ]
  });
}

export async function replayTransferBackedScrap(params: {
  tenantId: string;
  workOrderId: string;
  workOrderExecutionId: string;
  itemId: string;
  quantity: number;
  uom: string;
  scrapMovementId: string;
  idempotencyKey: string | null;
  client: PoolClient;
}) {
  const executionRes = await params.client.query<{
    id: string;
    work_order_id: string;
    status: string;
    production_movement_id: string | null;
  }>(
    `SELECT id,
            work_order_id,
            status,
            production_movement_id
       FROM work_order_executions
      WHERE tenant_id = $1
        AND id = $2
        AND work_order_id = $3
      FOR UPDATE`,
    [params.tenantId, params.workOrderExecutionId, params.workOrderId]
  );
  if (executionRes.rowCount === 0) {
    throw buildReplayCorruptionError({
      tenantId: params.tenantId,
      aggregateType: 'work_order_execution',
      aggregateId: params.workOrderExecutionId,
      reason: 'work_order_scrap_execution_missing'
    });
  }
  const currentExecution = executionRes.rows[0];
  if (!currentExecution.production_movement_id) {
    throw buildReplayCorruptionError({
      tenantId: params.tenantId,
      aggregateType: 'work_order_execution',
      aggregateId: params.workOrderExecutionId,
      reason: 'work_order_scrap_execution_movement_missing'
    });
  }

  const qaSourceRows = await params.client.query<{
    location_id: string;
    warehouse_id: string | null;
  }>(
    `SELECT iml.location_id,
            l.warehouse_id
       FROM inventory_movement_lines iml
       JOIN locations l
         ON l.id = iml.location_id
        AND l.tenant_id = iml.tenant_id
      WHERE iml.tenant_id = $1
        AND iml.movement_id = $2
        AND iml.item_id = $3
        AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
        AND l.role = 'QA'
      GROUP BY iml.location_id, l.warehouse_id`,
    [params.tenantId, currentExecution.production_movement_id, params.itemId]
  );
  if (qaSourceRows.rowCount !== 1 || !qaSourceRows.rows[0]?.warehouse_id) {
    throw buildReplayCorruptionError({
      tenantId: params.tenantId,
      aggregateType: 'work_order_execution',
      aggregateId: params.workOrderExecutionId,
      reason: 'work_order_scrap_replay_scope_unresolved'
    });
  }
  const replaySourceLocationId = qaSourceRows.rows[0].location_id;
  const replayWarehouseId = qaSourceRows.rows[0].warehouse_id;
  const replayScrapLocationId = await getWarehouseDefaultLocationId(
    params.tenantId,
    replayWarehouseId,
    'SCRAP',
    params.client
  );
  if (!replayScrapLocationId) {
    throw buildReplayCorruptionError({
      tenantId: params.tenantId,
      aggregateType: 'work_order_execution',
      aggregateId: params.workOrderExecutionId,
      reason: 'work_order_scrap_location_missing'
    });
  }

  return buildTransferReplayResult({
    tenantId: params.tenantId,
    movementId: params.scrapMovementId,
    normalizedIdempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:transfer` : null,
    replayed: true,
    client: params.client,
    sourceLocationId: replaySourceLocationId,
    destinationLocationId: replayScrapLocationId,
    itemId: params.itemId,
    quantity: params.quantity,
    uom: params.uom,
    sourceWarehouseId: replayWarehouseId,
    destinationWarehouseId: replayWarehouseId,
    expectedLineCount: 2
  });
}
