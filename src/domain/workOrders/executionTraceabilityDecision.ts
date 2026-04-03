import type { PoolClient } from 'pg';

export type TraceabilityStatus =
  | 'NOT_APPLICABLE'
  | 'COMPLETE'
  | 'INCOMPLETE_REPAIRABLE'
  | 'CONFLICTING'
  | 'UNRESOLVABLE';

export type RequiredAction =
  | { type: 'REPAIR_EXECUTION_LINKS' }
  | { type: 'APPEND_TRACEABILITY' }
  | { type: 'NONE' }
  | { type: 'FAIL'; reason: string };

export interface TraceabilityMetadata {
  outputLotId?: string;
  outputLotCode?: string;
  inputLotCount?: number;
}

export interface TraceabilityDecisionResult {
  status: TraceabilityStatus;
  requiredActions: RequiredAction[];
  metadata: TraceabilityMetadata;
}

export type ExecutionTraceabilityDecision = TraceabilityDecisionResult & {
  reason: string | null;
  details: Record<string, unknown>;
};

function trimmedId(value?: string | null) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildTraceabilityDecision(params: {
  status: TraceabilityStatus;
  metadata?: TraceabilityMetadata;
  requiredActions?: RequiredAction[];
  reason?: string | null;
  details?: Record<string, unknown>;
}): ExecutionTraceabilityDecision {
  return {
    status: params.status,
    requiredActions: params.requiredActions ?? [{ type: 'NONE' }],
    metadata: params.metadata ?? {},
    reason: params.reason ?? null,
    details: params.details ?? {}
  };
}

export async function decideExecutionTraceability(params: {
  client: PoolClient;
  tenantId: string;
  executionId: string;
  outputItemId: string;
  receiveMovementId: string;
  executionOutputLotId: string | null;
  receiveMovementLotId: string | null;
}): Promise<ExecutionTraceabilityDecision> {
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
    return buildTraceabilityDecision({
      status: 'CONFLICTING',
      requiredActions: [{ type: 'FAIL', reason: 'traceability_authoritative_lot_mismatch' }],
      metadata: {
        ...(trimmedId(params.executionOutputLotId)
          ? { outputLotId: trimmedId(params.executionOutputLotId)! }
          : {}),
        inputLotCount
      },
      reason: 'traceability_authoritative_lot_mismatch',
      details: {
        executionOutputLotId: params.executionOutputLotId,
        receiveMovementLotId: params.receiveMovementLotId
      }
    });
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
      return buildTraceabilityDecision({
        status: 'UNRESOLVABLE',
        requiredActions: [{ type: 'FAIL', reason: 'traceability_missing_authoritative_output_lot' }],
        metadata: {
          inputLotCount
        },
        reason: 'traceability_missing_authoritative_output_lot',
        details: {
          produceLinkAnyCount,
          movementLotAnyCount
        }
      });
    }
    return buildTraceabilityDecision({
      status: 'NOT_APPLICABLE',
      metadata: {
        inputLotCount
      }
    });
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
    return buildTraceabilityDecision({
      status: 'UNRESOLVABLE',
      requiredActions: [{ type: 'FAIL', reason: 'traceability_output_lot_missing' }],
      metadata: {
        outputLotId: authoritativeOutputLotId,
        inputLotCount
      },
      reason: 'traceability_output_lot_missing',
      details: {
        outputLotId: authoritativeOutputLotId
      }
    });
  }

  const [
    produceLinkResult,
    produceLinkConflictResult,
    movementLotsResult,
    movementLotConflictResult
  ] = await Promise.all([
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
  const metadata: TraceabilityMetadata = {
    outputLotId: authoritativeOutputLotId,
    outputLotCode: lotResult.rows[0].lot_code,
    inputLotCount
  };

  if (produceLinkConflictCount > 0 || movementLotConflictCount > 0) {
    return buildTraceabilityDecision({
      status: 'CONFLICTING',
      requiredActions: [{ type: 'FAIL', reason: 'traceability_conflicting_linkage' }],
      metadata,
      reason: 'traceability_conflicting_linkage',
      details: {
        produceLinkConflictCount,
        movementLotConflictCount,
        outputLotId: authoritativeOutputLotId
      }
    });
  }

  if (producedLineCount <= 0) {
    return buildTraceabilityDecision({
      status: 'UNRESOLVABLE',
      requiredActions: [{ type: 'FAIL', reason: 'traceability_produced_lines_missing' }],
      metadata,
      reason: 'traceability_produced_lines_missing',
      details: {
        receiveMovementId: params.receiveMovementId,
        outputItemId: params.outputItemId
      }
    });
  }

  if (produceLinkCount > 0 && movementLotCount === producedLineCount) {
    return buildTraceabilityDecision({
      status: 'COMPLETE',
      metadata
    });
  }

  return buildTraceabilityDecision({
    status: 'INCOMPLETE_REPAIRABLE',
    requiredActions: [{ type: 'APPEND_TRACEABILITY' }],
    metadata,
    reason: 'traceability_side_effects_incomplete',
    details: {
      outputLotId: authoritativeOutputLotId,
      producedLineCount,
      produceLinkCount,
      movementLotCount
    }
  });
}
