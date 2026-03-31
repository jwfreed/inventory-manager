import type { PoolClient } from 'pg';
import { recordAuditLog } from '../../lib/audit';
import {
  buildMovementPostedEvent,
  buildRefreshItemCostSummaryProjectionOp
} from '../../modules/platform/application/inventoryMutationSupport';

export type ReceiptActor = { type: 'user' | 'system'; id?: string | null };

export function buildReceiptPostedEvents(
  movementId: string,
  idempotencyKey?: string | null
) {
  return [buildMovementPostedEvent(movementId, idempotencyKey ?? null)];
}

export function buildReceiptPostedEvent(
  movementId: string,
  idempotencyKey?: string | null
) {
  return buildMovementPostedEvent(movementId, idempotencyKey ?? null);
}

export function buildReceiptCostRefreshProjectionOps(
  tenantId: string,
  itemIds: Iterable<string>
) {
  return Array.from(new Set(itemIds)).map((itemId) => buildRefreshItemCostSummaryProjectionOp(tenantId, itemId));
}

export async function recordReceiptCreatedAuditEffect(params: {
  client: PoolClient;
  tenantId: string;
  actor?: ReceiptActor;
  receiptId: string;
  purchaseOrderId: string;
  lineCount: number;
  occurredAt: Date;
}) {
  if (!params.actor) {
    return;
  }
  await recordAuditLog(
    {
      tenantId: params.tenantId,
      actorType: params.actor.type,
      actorId: params.actor.id ?? null,
      action: 'create',
      entityType: 'purchase_order_receipt',
      entityId: params.receiptId,
      occurredAt: params.occurredAt,
      metadata: {
        purchaseOrderId: params.purchaseOrderId,
        status: 'posted',
        lineCount: params.lineCount
      }
    },
    params.client
  );
}

export async function recordReceiptCreateAuditLog(params: {
  client: PoolClient;
  tenantId: string;
  actor?: ReceiptActor;
  receiptId: string;
  purchaseOrderId: string;
  lineCount: number;
  occurredAt: Date;
}) {
  return recordReceiptCreatedAuditEffect(params);
}
