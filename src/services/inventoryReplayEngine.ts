import type { PoolClient } from 'pg';
import { roundQuantity, toNumber } from '../lib/numbers';
import {
  buildPostedDocumentReplayResult,
  buildReplayCorruptionError
} from '../modules/platform/application/inventoryMutationSupport';
import {
  classifyExecutionState,
  type ExecutionStateClassification
} from '../domain/workOrders/executionStateClassifier';
import { buildTransferReplayResult } from './transfers.service';
import { getWarehouseDefaultLocationId } from './warehouseDefaults.service';
import * as lotTraceability from './lotTraceabilityEngine';
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

function buildIrrecoverableExecutionStateError(params: {
  tenantId: string;
  workOrderId: string;
  executionId: string;
  classification: ExecutionStateClassification;
}) {
  return domainError('WO_EXECUTION_RECOVERY_IRRECOVERABLE', {
    tenantId: params.tenantId,
    workOrderId: params.workOrderId,
    executionId: params.executionId,
    executionState: params.classification.state,
    reason: params.classification.reason ?? 'execution_state_irrecoverable',
    ...params.classification.details
  });
}

async function applyExecutionLinkRepair(params: {
  client: PoolClient;
  tenantId: string;
  executionId: string;
  issueMovementId: string;
  receiveMovementId: string;
}) {
  await params.client.query(
    `UPDATE work_order_executions
        SET consumption_movement_id = COALESCE(consumption_movement_id, $1),
            production_movement_id = COALESCE(production_movement_id, $2)
      WHERE tenant_id = $3
        AND id = $4`,
    [
      params.issueMovementId,
      params.receiveMovementId,
      params.tenantId,
      params.executionId
    ]
  );
}

function hasRequiredAction(
  classification: ExecutionStateClassification,
  actionType: ExecutionStateClassification['requiredActions'][number]['type']
) {
  return classification.requiredActions.some((action) => action.type === actionType);
}

function buildLotTrackingMetadata(
  classification: ExecutionStateClassification
): { outputLotId: string; outputLotCode: string; inputLotCount: number } | undefined {
  if (!classification.metadata.outputLotId || !classification.metadata.outputLotCode) {
    return undefined;
  }
  return {
    outputLotId: classification.metadata.outputLotId,
    outputLotCode: classification.metadata.outputLotCode,
    inputLotCount: classification.metadata.inputLotCount ?? 0
  };
}

async function resolveBatchExecutionReplayState(params: {
  tenantId: string;
  workOrderId: string;
  executionId: string;
  issueMovementId?: string | null;
  receiveMovementId?: string | null;
  client: PoolClient;
}) {
  const classification = await classifyExecutionState({
    client: params.client,
    tenantId: params.tenantId,
    workOrderId: params.workOrderId,
    executionId: params.executionId,
    expectedIssueMovementId: params.issueMovementId ?? null,
    expectedReceiveMovementId: params.receiveMovementId ?? null
  });
  if (!classification.isReplayable || !classification.issueMovementId || !classification.receiveMovementId) {
    throw buildIrrecoverableExecutionStateError({
      tenantId: params.tenantId,
      workOrderId: params.workOrderId,
      executionId: params.executionId,
      classification
    });
  }
  if (hasRequiredAction(classification, 'REPAIR_EXECUTION_LINKS')) {
    await applyExecutionLinkRepair({
      client: params.client,
      tenantId: params.tenantId,
      executionId: params.executionId,
      issueMovementId: classification.issueMovementId,
      receiveMovementId: classification.receiveMovementId
    });
  }
  return classification;
}

export async function classifyBatchExecutionReplayState(params: {
  tenantId: string;
  workOrderId: string;
  executionId: string;
  issueMovementId?: string | null;
  receiveMovementId?: string | null;
  client: PoolClient;
}) {
  return classifyExecutionState({
    client: params.client,
    tenantId: params.tenantId,
    workOrderId: params.workOrderId,
    executionId: params.executionId,
    expectedIssueMovementId: params.issueMovementId ?? null,
    expectedReceiveMovementId: params.receiveMovementId ?? null
  });
}

export async function finalizeBatchExecutionTraceability(params: {
  tenantId: string;
  workOrderId: string;
  executionId: string;
  issueMovementId?: string | null;
  receiveMovementId?: string | null;
  client: PoolClient;
  traceability: {
    outputItemId: string;
    outputQty: number;
    outputUom: string;
    outputLotId?: string | null;
    outputLotCode?: string | null;
    inputLots?: ReadonlyArray<lotTraceability.WorkOrderInputLotLink>;
  };
}) {
  const initialClassification = await classifyExecutionState({
    client: params.client,
    tenantId: params.tenantId,
    workOrderId: params.workOrderId,
    executionId: params.executionId,
    expectedIssueMovementId: params.issueMovementId ?? null,
    expectedReceiveMovementId: params.receiveMovementId ?? null
  });

  if (!initialClassification.issueMovementId || !initialClassification.receiveMovementId) {
    throw buildIrrecoverableExecutionStateError({
      tenantId: params.tenantId,
      workOrderId: params.workOrderId,
      executionId: params.executionId,
      classification: initialClassification
    });
  }
  if (hasRequiredAction(initialClassification, 'FAIL')) {
    throw buildIrrecoverableExecutionStateError({
      tenantId: params.tenantId,
      workOrderId: params.workOrderId,
      executionId: params.executionId,
      classification: initialClassification
    });
  }

  if (hasRequiredAction(initialClassification, 'REPAIR_EXECUTION_LINKS')) {
    await applyExecutionLinkRepair({
      client: params.client,
      tenantId: params.tenantId,
      executionId: params.executionId,
      issueMovementId: initialClassification.issueMovementId,
      receiveMovementId: initialClassification.receiveMovementId
    });
  }

  if (hasRequiredAction(initialClassification, 'APPEND_TRACEABILITY')) {
    try {
      await lotTraceability.appendTraceabilityLinksInTx(params.client, params.tenantId, {
        executionId: params.executionId,
        outputItemId: params.traceability.outputItemId,
        outputQty: params.traceability.outputQty,
        outputUom: params.traceability.outputUom,
        outputLotId: params.traceability.outputLotId ?? null,
        outputLotCode: params.traceability.outputLotCode ?? null,
        inputLots: params.traceability.inputLots ? [...params.traceability.inputLots] : []
      });
    } catch (error: unknown) {
      if (!lotTraceability.isNonRetryableLotLinkError(error)) {
        const retryableError = error as { retrySqlState?: string; code?: string };
        throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
          reason: 'lot_linking_incomplete_after_post',
          workOrderId: params.workOrderId,
          executionId: params.executionId,
          sqlState: retryableError.retrySqlState ?? retryableError.code ?? null,
          hint: 'Retry with the same Idempotency-Key to finalize lot linking.'
        });
      }
      throw error;
    }
  }

  const finalClassification = await classifyExecutionState({
    client: params.client,
    tenantId: params.tenantId,
    workOrderId: params.workOrderId,
    executionId: params.executionId,
    expectedIssueMovementId: initialClassification.issueMovementId,
    expectedReceiveMovementId: initialClassification.receiveMovementId
  });

  if (hasRequiredAction(finalClassification, 'FAIL')) {
    throw buildIrrecoverableExecutionStateError({
      tenantId: params.tenantId,
      workOrderId: params.workOrderId,
      executionId: params.executionId,
      classification: finalClassification
    });
  }
  if (
    finalClassification.state !== 'VALID_COMPLETE'
    && finalClassification.state !== 'REPLAYABLE_COMPLETE'
    && finalClassification.state !== 'TOLERATED_DRIFT'
  ) {
    throw buildReplayCorruptionError({
      tenantId: params.tenantId,
      workOrderId: params.workOrderId,
      executionId: params.executionId,
      reason: 'execution_recovery_not_terminal',
      details: {
        state: finalClassification.state,
        requiredActions: finalClassification.requiredActions,
        traceabilityStatus: finalClassification.traceabilityStatus
      }
    });
  }

  return {
    classification: finalClassification,
    lotTracking: buildLotTrackingMetadata(finalClassification)
  };
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
  const classification = await resolveBatchExecutionReplayState({
    tenantId,
    workOrderId: row.work_order_id,
    executionId: row.id,
    issueMovementId: row.consumption_movement_id,
    receiveMovementId: row.production_movement_id,
    client
  });
  const resolvedIssueMovementId = classification.issueMovementId!;
  const resolvedReceiveMovementId = classification.receiveMovementId!;
  return {
    executionId: row.id,
    workOrderId: row.work_order_id,
    issueMovementId: resolvedIssueMovementId,
    receiveMovementId: resolvedReceiveMovementId,
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
  const classification = await resolveBatchExecutionReplayState({
    tenantId: params.tenantId,
    workOrderId: params.workOrderId,
    executionId: params.executionId,
    issueMovementId: params.issueMovementId,
    receiveMovementId: params.receiveMovementId,
    client: params.client
  });
  const resolvedIssueMovementId = classification.issueMovementId!;
  const resolvedReceiveMovementId = classification.receiveMovementId!;
  const replay = await buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      {
        movementId: resolvedIssueMovementId,
        expectedLineCount: params.expectedIssueLineCount,
        expectedDeterministicHash: params.expectedIssueDeterministicHash ?? null
      },
      {
        movementId: resolvedReceiveMovementId,
        expectedLineCount: params.expectedReceiveLineCount,
        expectedDeterministicHash: params.expectedReceiveDeterministicHash ?? null
      }
    ],
    client: params.client,
    preFetchIntegrityCheck: params.preFetchIntegrityCheck,
    fetchAggregateView: params.fetchAggregateView,
    aggregateNotFoundError: new Error('WO_EXECUTION_NOT_FOUND'),
    authoritativeEvents: [
      buildInventoryMovementPostedEvent(resolvedIssueMovementId, params.idempotencyKey ?? null),
      buildInventoryMovementPostedEvent(resolvedReceiveMovementId, params.idempotencyKey ?? null),
      buildWorkOrderProductionReportedEvent({
        executionId: params.executionId,
        workOrderId: params.workOrderId,
        issueMovementId: resolvedIssueMovementId,
        receiveMovementId: resolvedReceiveMovementId,
        producerIdempotencyKey: params.idempotencyKey ?? null
      })
    ]
  });
  if (replay.responseBody && typeof replay.responseBody === 'object') {
    const body = replay.responseBody as Record<string, unknown>;
    return {
      ...replay,
      responseBody: {
        ...body,
        issueMovementId: resolvedIssueMovementId,
        receiveMovementId: resolvedReceiveMovementId
      }
    };
  }
  return replay;
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
