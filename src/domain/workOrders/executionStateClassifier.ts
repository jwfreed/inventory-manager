import type { PoolClient } from 'pg';
import { roundQuantity, toNumber } from '../../lib/numbers';

export type ExecutionReplayState =
  | 'VALID_COMPLETE'
  | 'REPLAYABLE_COMPLETE'
  | 'RECOVERABLE_PARTIAL'
  | 'TOLERATED_DRIFT'
  | 'IRRECOVERABLE';

type ExecutionContextRow = {
  id: string;
  work_order_id: string;
  status: string;
  consumption_movement_id: string | null;
  production_movement_id: string | null;
  output_lot_id: string | null;
  output_item_id: string;
  quantity_completed: string | number | null;
  work_order_status: string;
};

type SourceBackedMovementRow = {
  id: string;
  movement_type: string;
  status: string;
  source_type: string | null;
  source_id: string | null;
  line_count: string | number;
};

type TraceabilityState = 'not_applicable' | 'complete' | 'incomplete';

export type ExecutionStateClassification = {
  state: ExecutionReplayState;
  isReplayable: boolean;
  isRecoverable: boolean;
  executionId: string | null;
  workOrderId: string | null;
  issueMovementId: string | null;
  receiveMovementId: string | null;
  quantityCompleted: number | null;
  workOrderStatus: string | null;
  traceabilityState: TraceabilityState;
  repairPatch: {
    consumptionMovementId?: string;
    productionMovementId?: string;
  } | null;
  reason: string | null;
  details: Record<string, unknown>;
};

function buildClassification(params: {
  state: ExecutionReplayState;
  executionId?: string | null;
  workOrderId?: string | null;
  issueMovementId?: string | null;
  receiveMovementId?: string | null;
  quantityCompleted?: string | number | null;
  workOrderStatus?: string | null;
  traceabilityState?: TraceabilityState;
  repairPatch?: ExecutionStateClassification['repairPatch'];
  reason?: string | null;
  details?: Record<string, unknown>;
}): ExecutionStateClassification {
  return {
    state: params.state,
    isReplayable: params.state !== 'IRRECOVERABLE',
    isRecoverable: params.state === 'RECOVERABLE_PARTIAL',
    executionId: params.executionId ?? null,
    workOrderId: params.workOrderId ?? null,
    issueMovementId: params.issueMovementId ?? null,
    receiveMovementId: params.receiveMovementId ?? null,
    quantityCompleted: params.quantityCompleted === undefined
      ? null
      : roundQuantity(toNumber(params.quantityCompleted ?? 0)),
    workOrderStatus: params.workOrderStatus ?? null,
    traceabilityState: params.traceabilityState ?? 'not_applicable',
    repairPatch: params.repairPatch ?? null,
    reason: params.reason ?? null,
    details: params.details ?? {}
  };
}

async function loadExecutionContext(params: {
  client: PoolClient;
  tenantId: string;
  workOrderId: string;
  executionId: string;
}) {
  const result = await params.client.query<ExecutionContextRow>(
    `SELECT e.id,
            e.work_order_id,
            e.status,
            e.consumption_movement_id,
            e.production_movement_id,
            e.output_lot_id,
            w.output_item_id,
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
    [params.tenantId, params.executionId, params.workOrderId]
  );
  return result.rows[0] ?? null;
}

async function loadSourceBackedMovements(params: {
  client: PoolClient;
  tenantId: string;
  executionId: string;
}) {
  const result = await params.client.query<SourceBackedMovementRow>(
    `SELECT im.id,
            im.movement_type,
            im.status,
            im.source_type,
            im.source_id,
            (
              SELECT COUNT(*)::int
                FROM inventory_movement_lines iml
               WHERE iml.tenant_id = im.tenant_id
                 AND iml.movement_id = im.id
            ) AS line_count
       FROM inventory_movements im
      WHERE im.tenant_id = $1
        AND im.source_id = $2
        AND im.source_type IN ('work_order_batch_post_issue', 'work_order_batch_post_completion')
      FOR UPDATE`,
    [params.tenantId, params.executionId]
  );
  return result.rows;
}

function ensureUniqueMovement(
  rows: SourceBackedMovementRow[],
  sourceType: 'work_order_batch_post_issue' | 'work_order_batch_post_completion'
) {
  const matches = rows.filter((row) => row.source_type === sourceType);
  if (matches.length !== 1) {
    return {
      row: null,
      reason: matches.length === 0 ? 'source_backed_movement_missing' : 'source_backed_movement_ambiguous',
      details: {
        sourceType,
        candidateIds: matches.map((row) => row.id)
      }
    };
  }
  return { row: matches[0], reason: null, details: {} };
}

function movementReadyDetails(
  row: SourceBackedMovementRow,
  expectedMovementType: 'issue' | 'receive'
) {
  const lineCount = Number(row.line_count ?? 0);
  if (row.status !== 'posted') {
    return { ready: false, reason: 'source_backed_movement_not_posted', details: { movementId: row.id, status: row.status } };
  }
  if (row.movement_type !== expectedMovementType) {
    return {
      ready: false,
      reason: 'source_backed_movement_type_invalid',
      details: { movementId: row.id, movementType: row.movement_type, expectedMovementType }
    };
  }
  if (lineCount <= 0) {
    return { ready: false, reason: 'source_backed_movement_lines_missing', details: { movementId: row.id, lineCount } };
  }
  return { ready: true, reason: null, details: {} };
}

async function detectTraceabilityState(params: {
  client: PoolClient;
  tenantId: string;
  executionId: string;
  outputLotId: string | null;
  outputItemId: string;
  receiveMovementId: string;
}) {
  if (!params.outputLotId) {
    return 'not_applicable' as const;
  }

  const produceLinkResult = await params.client.query<{ exists: boolean }>(
    `SELECT EXISTS (
         SELECT 1
           FROM work_order_lot_links
          WHERE tenant_id = $1
            AND work_order_execution_id = $2
            AND role = 'produce'
            AND item_id = $3
            AND lot_id = $4
       ) AS exists`,
    [params.tenantId, params.executionId, params.outputItemId, params.outputLotId]
  );
  const producedLinesResult = await params.client.query<{ count: string | number }>(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
        AND item_id = $3
        AND COALESCE(quantity_delta_canonical, quantity_delta) > 0`,
    [params.tenantId, params.receiveMovementId, params.outputItemId]
  );
  const movementLotsResult = await params.client.query<{ count: string | number }>(
    `SELECT COUNT(DISTINCT iml.id)::int AS count
       FROM inventory_movement_lots lot
       JOIN inventory_movement_lines iml
         ON iml.id = lot.inventory_movement_line_id
        AND iml.tenant_id = lot.tenant_id
      WHERE lot.tenant_id = $1
        AND iml.movement_id = $2
        AND iml.item_id = $3
        AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
        AND lot.lot_id = $4`,
    [params.tenantId, params.receiveMovementId, params.outputItemId, params.outputLotId]
  );

  const hasProduceLink = !!produceLinkResult.rows[0]?.exists;
  const producedLineCount = Number(producedLinesResult.rows[0]?.count ?? 0);
  const movementLotCount = Number(movementLotsResult.rows[0]?.count ?? 0);
  return hasProduceLink && producedLineCount > 0 && movementLotCount === producedLineCount
    ? 'complete' as const
    : 'incomplete' as const;
}

function trimmedId(value?: string | null) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function classifyExecutionState(params: {
  client: PoolClient;
  tenantId: string;
  workOrderId: string;
  executionId: string;
  expectedIssueMovementId?: string | null;
  expectedReceiveMovementId?: string | null;
}) {
  const execution = await loadExecutionContext(params);
  if (!execution) {
    return buildClassification({
      state: 'IRRECOVERABLE',
      executionId: params.executionId,
      workOrderId: params.workOrderId,
      reason: 'execution_missing',
      details: {
        executionId: params.executionId,
        workOrderId: params.workOrderId
      }
    });
  }

  if (execution.status !== 'posted') {
    return buildClassification({
      state: 'IRRECOVERABLE',
      executionId: execution.id,
      workOrderId: execution.work_order_id,
      quantityCompleted: execution.quantity_completed,
      workOrderStatus: execution.work_order_status,
      reason: 'execution_not_posted',
      details: {
        executionStatus: execution.status
      }
    });
  }

  const sourceBackedRows = await loadSourceBackedMovements({
    client: params.client,
    tenantId: params.tenantId,
    executionId: execution.id
  });
  const issueResolution = ensureUniqueMovement(sourceBackedRows, 'work_order_batch_post_issue');
  if (!issueResolution.row) {
    return buildClassification({
      state: 'IRRECOVERABLE',
      executionId: execution.id,
      workOrderId: execution.work_order_id,
      quantityCompleted: execution.quantity_completed,
      workOrderStatus: execution.work_order_status,
      reason: issueResolution.reason,
      details: issueResolution.details
    });
  }
  const receiveResolution = ensureUniqueMovement(sourceBackedRows, 'work_order_batch_post_completion');
  if (!receiveResolution.row) {
    return buildClassification({
      state: 'IRRECOVERABLE',
      executionId: execution.id,
      workOrderId: execution.work_order_id,
      quantityCompleted: execution.quantity_completed,
      workOrderStatus: execution.work_order_status,
      reason: receiveResolution.reason,
      details: receiveResolution.details
    });
  }

  const sourceIssue = issueResolution.row;
  const sourceReceive = receiveResolution.row;
  const issueReady = movementReadyDetails(sourceIssue, 'issue');
  if (!issueReady.ready) {
    return buildClassification({
      state: 'IRRECOVERABLE',
      executionId: execution.id,
      workOrderId: execution.work_order_id,
      issueMovementId: sourceIssue.id,
      receiveMovementId: sourceReceive.id,
      quantityCompleted: execution.quantity_completed,
      workOrderStatus: execution.work_order_status,
      reason: issueReady.reason,
      details: issueReady.details
    });
  }
  const receiveReady = movementReadyDetails(sourceReceive, 'receive');
  if (!receiveReady.ready) {
    return buildClassification({
      state: 'IRRECOVERABLE',
      executionId: execution.id,
      workOrderId: execution.work_order_id,
      issueMovementId: sourceIssue.id,
      receiveMovementId: sourceReceive.id,
      quantityCompleted: execution.quantity_completed,
      workOrderStatus: execution.work_order_status,
      reason: receiveReady.reason,
      details: receiveReady.details
    });
  }

  const expectedIssueMovementId = trimmedId(params.expectedIssueMovementId);
  const expectedReceiveMovementId = trimmedId(params.expectedReceiveMovementId);
  const hasReplayExpectation = !!expectedIssueMovementId || !!expectedReceiveMovementId;
  const replayDrift: string[] = [];
  if (expectedIssueMovementId && expectedIssueMovementId !== sourceIssue.id) {
    replayDrift.push('expected_issue_movement_mismatch');
  }
  if (expectedReceiveMovementId && expectedReceiveMovementId !== sourceReceive.id) {
    replayDrift.push('expected_receive_movement_mismatch');
  }
  if (replayDrift.length > 0) {
    return buildClassification({
      state: 'IRRECOVERABLE',
      executionId: execution.id,
      workOrderId: execution.work_order_id,
      issueMovementId: sourceIssue.id,
      receiveMovementId: sourceReceive.id,
      quantityCompleted: execution.quantity_completed,
      workOrderStatus: execution.work_order_status,
      reason: 'idempotent_response_movement_mismatch',
      details: {
        replayDrift,
        expectedIssueMovementId,
        expectedReceiveMovementId
      }
    });
  }

  const executionDrift: string[] = [];
  const repairPatch: NonNullable<ExecutionStateClassification['repairPatch']> = {};
  if (!execution.consumption_movement_id) {
    repairPatch.consumptionMovementId = sourceIssue.id;
  } else if (execution.consumption_movement_id !== sourceIssue.id) {
    executionDrift.push('execution_issue_movement_mismatch');
  }
  if (!execution.production_movement_id) {
    repairPatch.productionMovementId = sourceReceive.id;
  } else if (execution.production_movement_id !== sourceReceive.id) {
    executionDrift.push('execution_receive_movement_mismatch');
  }

  const traceabilityState = await detectTraceabilityState({
    client: params.client,
    tenantId: params.tenantId,
    executionId: execution.id,
    outputLotId: execution.output_lot_id,
    outputItemId: execution.output_item_id,
    receiveMovementId: sourceReceive.id
  });

  if (executionDrift.length > 0) {
    return buildClassification({
      state: 'TOLERATED_DRIFT',
      executionId: execution.id,
      workOrderId: execution.work_order_id,
      issueMovementId: sourceIssue.id,
      receiveMovementId: sourceReceive.id,
      quantityCompleted: execution.quantity_completed,
      workOrderStatus: execution.work_order_status,
      traceabilityState,
      reason: 'linkage_drift_tolerated',
      details: {
        executionDrift,
        persistedConsumptionMovementId: execution.consumption_movement_id,
        persistedProductionMovementId: execution.production_movement_id,
        expectedIssueMovementId: expectedIssueMovementId ?? null,
        expectedReceiveMovementId: expectedReceiveMovementId ?? null
      }
    });
  }

  if (Object.keys(repairPatch).length > 0) {
    return buildClassification({
      state: 'RECOVERABLE_PARTIAL',
      executionId: execution.id,
      workOrderId: execution.work_order_id,
      issueMovementId: sourceIssue.id,
      receiveMovementId: sourceReceive.id,
      quantityCompleted: execution.quantity_completed,
      workOrderStatus: execution.work_order_status,
      traceabilityState,
      repairPatch,
      reason: 'missing_execution_linkage',
      details: {
        missingFields: Object.keys(repairPatch)
      }
    });
  }

  if (traceabilityState === 'incomplete') {
    return buildClassification({
      state: 'RECOVERABLE_PARTIAL',
      executionId: execution.id,
      workOrderId: execution.work_order_id,
      issueMovementId: sourceIssue.id,
      receiveMovementId: sourceReceive.id,
      quantityCompleted: execution.quantity_completed,
      workOrderStatus: execution.work_order_status,
      traceabilityState,
      reason: 'traceability_side_effects_incomplete'
    });
  }

  return buildClassification({
    state: hasReplayExpectation ? 'REPLAYABLE_COMPLETE' : 'VALID_COMPLETE',
    executionId: execution.id,
    workOrderId: execution.work_order_id,
    issueMovementId: sourceIssue.id,
    receiveMovementId: sourceReceive.id,
    quantityCompleted: execution.quantity_completed,
    workOrderStatus: execution.work_order_status,
    traceabilityState,
    reason: 'execution_complete'
  });
}
