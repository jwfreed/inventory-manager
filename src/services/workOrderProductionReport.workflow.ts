import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { workOrderReportProductionSchema } from '../schemas/workOrderExecution.schema';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import {
  buildReportProductionPlan
} from '../domain/workOrders/reportProductionPlan';
import {
  assertReportProductionWarehouseSellableDefault,
  evaluateReportProductionPolicy
} from '../domain/workOrders/reportProductionPolicy';
import { recordWorkOrderBatch } from './workOrderBatchRecord.workflow';
import * as replayEngine from './inventoryReplayEngine';
import type { NegativeOverrideContext } from './workOrderExecution.types';

type WorkOrderReportProductionInput = z.infer<typeof workOrderReportProductionSchema>;

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

// Module-scoped set tracks test-only simulated lot-link failure keys.
// Once a key has triggered a simulated failure, it is added here so subsequent
// retries with the same key proceed normally (idempotency-driven recovery path).
const FORCED_LOT_LINK_FAILURE_KEYS = new Set<string>();

function shouldSimulateLotLinkFailureOnce(idempotencyKey: string | null, replayed: boolean) {
  if (replayed || !idempotencyKey) return false;
  // Guarded by an explicit test-only key marker to avoid env-coupled flakiness.
  if (!idempotencyKey.includes(':simulate-lot-link-failure')) return false;
  if (FORCED_LOT_LINK_FAILURE_KEYS.has(idempotencyKey)) return false;
  FORCED_LOT_LINK_FAILURE_KEYS.add(idempotencyKey);
  return true;
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

// WF-6: Report Work Order Production
//
// This workflow is the explicit TWO-TRANSACTION exception in Sprint 3 Phase B.
//
// TX-1 — authoritative inventory mutation, owned by recordWorkOrderBatch():
//   All inventory movements, cost/WIP mutations, reservation consumption, batch
//   linkage, and projections execute inside a single runInventoryCommand() boundary.
//
// TX-2 — traceability finalization, owned here via withTransaction():
//   Lot link repair and traceability append. Not authoritative for inventory truth.
//   May be incomplete if TX-1 succeeds and TX-2 fails; recovery is idempotency-driven
//   (retry with the same idempotency key).
//
// Failure modes:
//   TX-1 succeeds, TX-2 fails     → posted inventory with incomplete traceability; retry
//   Lot linking non-retryable     → escalate; manual repair required
//   Execution classifier FAIL     → WO_EXECUTION_RECOVERY_IRRECOVERABLE; stop
//
// This seam must remain visible. Do not collapse to a single transaction.
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

  // TX-1: authoritative inventory mutation via recordWorkOrderBatch() -> runInventoryCommand()
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

  // TX-2: traceability finalization — intentionally a separate transaction boundary.
  // Inventory truth is already committed in TX-1. This step appends lot links and
  // repairs execution movement references. Failure here leaves inventory correctly
  // posted; the operator retries with the same idempotency key to complete TX-2.
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
