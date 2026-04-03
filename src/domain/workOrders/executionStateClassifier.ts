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
  lot_id: string | null;
  line_count: string | number;
};

export type TraceabilityStatus =
  | 'NOT_APPLICABLE'
  | 'COMPLETE'
  | 'INCOMPLETE_REPAIRABLE'
  | 'CONFLICTING'
  | 'UNRESOLVABLE';

export type ExecutionRequiredAction =
  | { type: 'REPAIR_EXECUTION_LINKS' }
  | { type: 'APPEND_TRACEABILITY' }
  | { type: 'NONE' }
  | { type: 'FAIL'; reason: string };

export type ExecutionStateClassification = {
  state: ExecutionReplayState;
  isReplayable: boolean;
  isRecoverable: boolean;
  executionId: string | null;
  workOrderId: string | null;
  issueMovementId: string | null;
  receiveMovementId: string | null;
  authoritativeMovementIds: {
    issueMovementId: string | null;
    receiveMovementId: string | null;
  };
  quantityCompleted: number | null;
  workOrderStatus: string | null;
  traceabilityStatus: TraceabilityStatus;
  requiredActions: ExecutionRequiredAction[];
  metadata: {
    outputLotId?: string;
    outputLotCode?: string;
    inputLotCount?: number;
  };
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
  traceabilityStatus?: TraceabilityStatus;
  requiredActions?: ExecutionRequiredAction[];
  metadata?: ExecutionStateClassification['metadata'];
  reason?: string | null;
  details?: Record<string, unknown>;
}): ExecutionStateClassification {
  const issueMovementId = params.issueMovementId ?? null;
  const receiveMovementId = params.receiveMovementId ?? null;
  const requiredActions = params.requiredActions ?? (
    params.state === 'IRRECOVERABLE'
      ? [{ type: 'FAIL', reason: params.reason ?? 'irrecoverable' }]
      : [{ type: 'NONE' }]
  );
  return {
    state: params.state,
    isReplayable: !requiredActions.some((action) => action.type === 'FAIL'),
    isRecoverable: requiredActions.some(
      (action) => action.type === 'REPAIR_EXECUTION_LINKS' || action.type === 'APPEND_TRACEABILITY'
    ),
    executionId: params.executionId ?? null,
    workOrderId: params.workOrderId ?? null,
    issueMovementId,
    receiveMovementId,
    authoritativeMovementIds: {
      issueMovementId,
      receiveMovementId
    },
    quantityCompleted: params.quantityCompleted === undefined
      ? null
      : roundQuantity(toNumber(params.quantityCompleted ?? 0)),
    workOrderStatus: params.workOrderStatus ?? null,
    traceabilityStatus: params.traceabilityStatus ?? 'NOT_APPLICABLE',
    requiredActions,
    metadata: params.metadata ?? {},
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
            im.lot_id,
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

async function detectTraceabilityStatus(params: {
  client: PoolClient;
  tenantId: string;
  executionId: string;
  outputItemId: string;
  receiveMovementId: string;
  executionOutputLotId: string | null;
  receiveMovementLotId: string | null;
}) {
  const authoritativeOutputLotId = trimmedId(params.executionOutputLotId) ?? trimmedId(params.receiveMovementLotId);
  const [inputLotCountResult, producedLinesResult] = await Promise.all([
    params.client.query<{ count: string | number }>(
      `SELECT COUNT(*)::int AS count
         FROM work_order_lot_links
        WHERE tenant_id = $1
          AND work_order_execution_id = $2
          AND role = 'consume'`,
      [params.tenantId, params.executionId]
    ),
    params.client.query<{ count: string | number }>(
      `SELECT COUNT(*)::int AS count
         FROM inventory_movement_lines
        WHERE tenant_id = $1
          AND movement_id = $2
          AND item_id = $3
          AND COALESCE(quantity_delta_canonical, quantity_delta) > 0`,
      [params.tenantId, params.receiveMovementId, params.outputItemId]
    )
  ]);
  const inputLotCount = Number(inputLotCountResult.rows[0]?.count ?? 0);
  const producedLineCount = Number(producedLinesResult.rows[0]?.count ?? 0);

  if (
    trimmedId(params.executionOutputLotId)
    && trimmedId(params.receiveMovementLotId)
    && params.executionOutputLotId !== params.receiveMovementLotId
  ) {
    return {
      status: 'CONFLICTING' as const,
      metadata: {
        ...(trimmedId(params.executionOutputLotId) ? { outputLotId: trimmedId(params.executionOutputLotId)! } : {}),
        inputLotCount
      },
      reason: 'traceability_authoritative_lot_mismatch',
      details: {
        executionOutputLotId: params.executionOutputLotId,
        receiveMovementLotId: params.receiveMovementLotId
      }
    };
  }

  if (!authoritativeOutputLotId) {
    const [produceLinkAnyResult, movementLotAnyResult] = await Promise.all([
      params.client.query<{ count: string | number }>(
        `SELECT COUNT(*)::int AS count
           FROM work_order_lot_links
          WHERE tenant_id = $1
            AND work_order_execution_id = $2
            AND role = 'produce'
            AND item_id = $3`,
        [params.tenantId, params.executionId, params.outputItemId]
      ),
      params.client.query<{ count: string | number }>(
        `SELECT COUNT(DISTINCT lot.inventory_movement_line_id)::int AS count
           FROM inventory_movement_lots lot
           JOIN inventory_movement_lines iml
             ON iml.id = lot.inventory_movement_line_id
            AND iml.tenant_id = lot.tenant_id
          WHERE lot.tenant_id = $1
            AND iml.movement_id = $2
            AND iml.item_id = $3
            AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0`,
        [params.tenantId, params.receiveMovementId, params.outputItemId]
      )
    ]);
    const produceLinkAnyCount = Number(produceLinkAnyResult.rows[0]?.count ?? 0);
    const movementLotAnyCount = Number(movementLotAnyResult.rows[0]?.count ?? 0);
    if (produceLinkAnyCount > 0 || movementLotAnyCount > 0) {
      return {
        status: 'UNRESOLVABLE' as const,
        metadata: {
          inputLotCount
        },
        reason: 'traceability_missing_authoritative_output_lot',
        details: {
          produceLinkAnyCount,
          movementLotAnyCount
        }
      };
    }
    return {
      status: 'NOT_APPLICABLE' as const,
      metadata: {
        inputLotCount
      },
      reason: null,
      details: {}
    };
  }

  const lotResult = await params.client.query<{ lot_code: string }>(
    `SELECT lot_code
       FROM lots
      WHERE tenant_id = $1
        AND id = $2
        AND item_id = $3
      LIMIT 1`,
    [params.tenantId, authoritativeOutputLotId, params.outputItemId]
  );
  if (!lotResult.rows[0]) {
    return {
      status: 'UNRESOLVABLE' as const,
      metadata: {
        ...(authoritativeOutputLotId ? { outputLotId: authoritativeOutputLotId } : {}),
        inputLotCount
      },
      reason: 'traceability_output_lot_missing',
      details: {
        outputLotId: authoritativeOutputLotId
      }
    };
  }

  const [produceLinkResult, produceLinkConflictResult, movementLotsResult, movementLotConflictResult] = await Promise.all([
    params.client.query<{ count: string | number }>(
      `SELECT COUNT(*)::int AS count
         FROM work_order_lot_links
        WHERE tenant_id = $1
          AND work_order_execution_id = $2
          AND role = 'produce'
          AND item_id = $3
          AND lot_id = $4`,
      [params.tenantId, params.executionId, params.outputItemId, authoritativeOutputLotId]
    ),
    params.client.query<{ count: string | number }>(
      `SELECT COUNT(*)::int AS count
         FROM work_order_lot_links
        WHERE tenant_id = $1
          AND work_order_execution_id = $2
          AND role = 'produce'
          AND item_id = $3
          AND lot_id <> $4`,
      [params.tenantId, params.executionId, params.outputItemId, authoritativeOutputLotId]
    ),
    params.client.query<{ count: string | number }>(
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
      [params.tenantId, params.receiveMovementId, params.outputItemId, authoritativeOutputLotId]
    ),
    params.client.query<{ count: string | number }>(
      `SELECT COUNT(DISTINCT iml.id)::int AS count
         FROM inventory_movement_lots lot
         JOIN inventory_movement_lines iml
           ON iml.id = lot.inventory_movement_line_id
          AND iml.tenant_id = lot.tenant_id
        WHERE lot.tenant_id = $1
          AND iml.movement_id = $2
          AND iml.item_id = $3
          AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
          AND lot.lot_id <> $4`,
      [params.tenantId, params.receiveMovementId, params.outputItemId, authoritativeOutputLotId]
    )
  ]);

  const produceLinkCount = Number(produceLinkResult.rows[0]?.count ?? 0);
  const produceLinkConflictCount = Number(produceLinkConflictResult.rows[0]?.count ?? 0);
  const movementLotCount = Number(movementLotsResult.rows[0]?.count ?? 0);
  const movementLotConflictCount = Number(movementLotConflictResult.rows[0]?.count ?? 0);
  const metadata = {
    outputLotId: authoritativeOutputLotId,
    outputLotCode: lotResult.rows[0].lot_code,
    inputLotCount
  };

  if (produceLinkConflictCount > 0 || movementLotConflictCount > 0) {
    return {
      status: 'CONFLICTING' as const,
      metadata,
      reason: 'traceability_conflicting_linkage',
      details: {
        produceLinkConflictCount,
        movementLotConflictCount,
        outputLotId: authoritativeOutputLotId
      }
    };
  }

  if (producedLineCount <= 0) {
    return {
      status: 'UNRESOLVABLE' as const,
      metadata,
      reason: 'traceability_produced_lines_missing',
      details: {
        receiveMovementId: params.receiveMovementId,
        outputItemId: params.outputItemId
      }
    };
  }

  if (produceLinkCount > 0 && movementLotCount === producedLineCount) {
    return {
      status: 'COMPLETE' as const,
      metadata,
      reason: null,
      details: {}
    };
  }

  return {
    status: 'INCOMPLETE_REPAIRABLE' as const,
    metadata,
    reason: 'traceability_side_effects_incomplete',
    details: {
      outputLotId: authoritativeOutputLotId,
      producedLineCount,
      produceLinkCount,
      movementLotCount
    }
  };
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
      traceabilityStatus: 'NOT_APPLICABLE',
      requiredActions: [{ type: 'FAIL', reason: 'idempotent_response_movement_mismatch' }],
      reason: 'idempotent_response_movement_mismatch',
      details: {
        replayDrift,
        expectedIssueMovementId,
        expectedReceiveMovementId
      }
    });
  }

  const executionDrift: string[] = [];
  let missingExecutionLinkage = false;
  if (!execution.consumption_movement_id) {
    missingExecutionLinkage = true;
  } else if (execution.consumption_movement_id !== sourceIssue.id) {
    executionDrift.push('execution_issue_movement_mismatch');
  }
  if (!execution.production_movement_id) {
    missingExecutionLinkage = true;
  } else if (execution.production_movement_id !== sourceReceive.id) {
    executionDrift.push('execution_receive_movement_mismatch');
  }

  const traceability = await detectTraceabilityStatus({
    client: params.client,
    tenantId: params.tenantId,
    executionId: execution.id,
    outputItemId: execution.output_item_id,
    receiveMovementId: sourceReceive.id,
    executionOutputLotId: execution.output_lot_id,
    receiveMovementLotId: sourceReceive.lot_id
  });

  const baseParams = {
    executionId: execution.id,
    workOrderId: execution.work_order_id,
    issueMovementId: sourceIssue.id,
    receiveMovementId: sourceReceive.id,
    quantityCompleted: execution.quantity_completed,
    workOrderStatus: execution.work_order_status,
    traceabilityStatus: traceability.status,
    metadata: traceability.metadata
  };

  if (traceability.status === 'CONFLICTING' || traceability.status === 'UNRESOLVABLE') {
    return buildClassification({
      ...baseParams,
      state: 'IRRECOVERABLE',
      requiredActions: [{ type: 'FAIL', reason: traceability.reason ?? 'traceability_irrecoverable' }],
      reason: traceability.reason ?? 'traceability_irrecoverable',
      details: traceability.details
    });
  }

  if (executionDrift.length > 0) {
    const requiredActions: ExecutionRequiredAction[] = traceability.status === 'INCOMPLETE_REPAIRABLE'
      ? [{ type: 'APPEND_TRACEABILITY' }]
      : [{ type: 'NONE' }];
    return buildClassification({
      ...baseParams,
      state: 'TOLERATED_DRIFT',
      requiredActions,
      reason: 'linkage_drift_tolerated',
      details: {
        executionDrift,
        persistedConsumptionMovementId: execution.consumption_movement_id,
        persistedProductionMovementId: execution.production_movement_id,
        expectedIssueMovementId: expectedIssueMovementId ?? null,
        expectedReceiveMovementId: expectedReceiveMovementId ?? null,
        ...traceability.details
      }
    });
  }

  const requiredActions: ExecutionRequiredAction[] = [];
  if (missingExecutionLinkage) {
    requiredActions.push({ type: 'REPAIR_EXECUTION_LINKS' });
  }
  if (traceability.status === 'INCOMPLETE_REPAIRABLE') {
    requiredActions.push({ type: 'APPEND_TRACEABILITY' });
  }

  if (requiredActions.length > 0) {
    return buildClassification({
      ...baseParams,
      state: 'RECOVERABLE_PARTIAL',
      requiredActions,
      reason: missingExecutionLinkage
        ? 'missing_execution_linkage'
        : (traceability.reason ?? 'traceability_side_effects_incomplete'),
      details: {
        missingFields: missingExecutionLinkage
          ? [
            ...(execution.consumption_movement_id ? [] : ['consumptionMovementId']),
            ...(execution.production_movement_id ? [] : ['productionMovementId'])
          ]
          : [],
        ...traceability.details
      }
    });
  }

  return buildClassification({
    ...baseParams,
    state: hasReplayExpectation ? 'REPLAYABLE_COMPLETE' : 'VALID_COMPLETE',
    requiredActions: [{ type: 'NONE' }],
    reason: 'execution_complete'
  });
}
