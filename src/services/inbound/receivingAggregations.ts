import type { PoolClient } from 'pg';
import { query } from '../../db';
import { roundQuantity, toNumber } from '../../lib/numbers';

export type QcBreakdown = { hold: number; accept: number; reject: number; disposed?: number };

export type ReceiptLineContext = {
  id: string;
  receiptId: string;
  purchaseOrderId: string;
  itemId: string;
  uom: string;
  quantityReceived: number;
  defaultFromLocationId: string | null;
};

export type PutawayTotals = {
  posted: number;
  pending: number;
  qa: number;
  hold: number;
};

export function defaultBreakdown(): QcBreakdown {
  return { hold: 0, accept: 0, reject: 0, disposed: 0 };
}

export async function loadReceiptLineContexts(
  tenantId: string,
  lineIds: string[],
  client?: PoolClient
): Promise<Map<string, ReceiptLineContext>> {
  const map = new Map<string, ReceiptLineContext>();
  if (lineIds.length === 0) {
    return map;
  }
  const executor = client ? client.query.bind(client) : query;
  const { rows } = await executor(
    `SELECT
        prl.id,
        prl.purchase_order_receipt_id,
        prl.quantity_received,
        prl.uom,
        pol.item_id,
        pol.purchase_order_id,
        por.received_to_location_id,
        i.default_location_id
     FROM purchase_order_receipt_lines prl
     JOIN purchase_order_lines pol ON pol.id = prl.purchase_order_line_id AND pol.tenant_id = prl.tenant_id
     JOIN purchase_order_receipts por ON por.id = prl.purchase_order_receipt_id AND por.tenant_id = prl.tenant_id
     LEFT JOIN items i ON i.id = pol.item_id AND i.tenant_id = prl.tenant_id
     WHERE prl.id = ANY($1::uuid[]) AND prl.tenant_id = $2`,
    [lineIds, tenantId]
  );
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      receiptId: row.purchase_order_receipt_id,
      purchaseOrderId: row.purchase_order_id,
      itemId: row.item_id,
      uom: row.uom,
      quantityReceived: roundQuantity(toNumber(row.quantity_received)),
      defaultFromLocationId: row.received_to_location_id ?? row.default_location_id ?? null
    });
  }
  return map;
}

export async function loadPutawayTotals(
  tenantId: string,
  lineIds: string[],
  client?: PoolClient
): Promise<Map<string, PutawayTotals>> {
  const map = new Map<string, PutawayTotals>();
  if (lineIds.length === 0) {
    return map;
  }
  const executor = client ? client.query.bind(client) : query;
  const { rows } = await executor(
    `WITH pending_putaway AS (
        SELECT purchase_order_receipt_line_id AS line_id,
               COALESCE(SUM(CASE WHEN status = 'pending' THEN COALESCE(quantity_planned, 0) ELSE 0 END), 0)::numeric AS pending_qty
          FROM putaway_lines
         WHERE purchase_order_receipt_line_id = ANY($1::uuid[])
           AND tenant_id = $2
           AND status <> 'canceled'
         GROUP BY purchase_order_receipt_line_id
      ),
      allocations AS (
        SELECT purchase_order_receipt_line_id AS line_id,
               COALESCE(SUM(CASE WHEN status = 'AVAILABLE' THEN quantity ELSE 0 END), 0)::numeric AS posted_qty,
               COALESCE(SUM(CASE WHEN status = 'QA' THEN quantity ELSE 0 END), 0)::numeric AS qa_qty,
               COALESCE(SUM(CASE WHEN status = 'HOLD' THEN quantity ELSE 0 END), 0)::numeric AS hold_qty
          FROM receipt_allocations
         WHERE purchase_order_receipt_line_id = ANY($1::uuid[])
           AND tenant_id = $2
         GROUP BY purchase_order_receipt_line_id
      )
      SELECT prl.id AS line_id,
             COALESCE(a.posted_qty, 0) AS posted_qty,
             COALESCE(pp.pending_qty, 0) AS pending_qty,
             COALESCE(a.qa_qty, 0) AS qa_qty,
             COALESCE(a.hold_qty, 0) AS hold_qty
        FROM purchase_order_receipt_lines prl
        LEFT JOIN pending_putaway pp ON pp.line_id = prl.id
        LEFT JOIN allocations a ON a.line_id = prl.id
       WHERE prl.id = ANY($1::uuid[])
         AND prl.tenant_id = $2`,
    [lineIds, tenantId]
  );
  for (const row of rows) {
    map.set(row.line_id, {
      posted: roundQuantity(toNumber(row.posted_qty)),
      pending: roundQuantity(toNumber(row.pending_qty)),
      qa: roundQuantity(toNumber(row.qa_qty)),
      hold: roundQuantity(toNumber(row.hold_qty))
    });
  }
  return map;
}

export async function loadQcBreakdown(
  tenantId: string,
  lineIds: string[],
  client?: PoolClient
): Promise<Map<string, QcBreakdown>> {
  const map = new Map<string, QcBreakdown>();
  if (lineIds.length === 0) {
    return map;
  }
  const executor = client ? client.query.bind(client) : query;
  const { rows } = await executor(
    `SELECT purchase_order_receipt_line_id AS line_id, event_type, SUM(quantity) AS total_quantity
       FROM qc_events
       WHERE purchase_order_receipt_line_id = ANY($1::uuid[])
         AND tenant_id = $2
       GROUP BY purchase_order_receipt_line_id, event_type`,
    [lineIds, tenantId]
  );
  for (const row of rows) {
    const lineId = row.line_id as string;
    const breakdown = map.get(lineId) ?? defaultBreakdown();
    const eventType = row.event_type as keyof QcBreakdown;
    breakdown[eventType] = roundQuantity(toNumber(row.total_quantity));
    map.set(lineId, breakdown);
  }
  // Subtract disposed hold quantities so downstream logic sees net hold.
  const { rows: dispositionRows } = await executor(
    `SELECT purchase_order_receipt_line_id AS line_id, SUM(quantity) AS total_disposed
       FROM hold_disposition_events
      WHERE purchase_order_receipt_line_id = ANY($1::uuid[])
        AND tenant_id = $2
      GROUP BY purchase_order_receipt_line_id`,
    [lineIds, tenantId]
  );
  for (const row of dispositionRows) {
    const lineId = row.line_id as string;
    const breakdown = map.get(lineId) ?? defaultBreakdown();
    const disposed = roundQuantity(toNumber(row.total_disposed));
    breakdown.hold = roundQuantity(Math.max(0, (breakdown.hold ?? 0) - disposed));
    breakdown.disposed = roundQuantity((breakdown.disposed ?? 0) + disposed);
    map.set(lineId, breakdown);
  }
  return map;
}

export function calculatePutawayAvailability(
  context: ReceiptLineContext,
  qcBreakdown: QcBreakdown,
  totals: PutawayTotals,
  excludePendingQuantity = 0,
  options: { requireAcceptance?: boolean } = {}
) {
  const receiptQty = roundQuantity(context.quantityReceived);
  const rejected = roundQuantity(qcBreakdown.reject ?? 0);
  const hold = roundQuantity(qcBreakdown.hold ?? 0);
  const accept = roundQuantity(qcBreakdown.accept ?? 0);
  // disposed units (REWORK/DISCARDED) were inspected via QC hold before disposition;
  // include them in inspectedTotal so they are not misclassified as uninspected.
  const disposed = roundQuantity(qcBreakdown.disposed ?? 0);
  const inspectedTotal = roundQuantity(accept + hold + rejected + disposed);
  const remainingUninspected = Math.max(0, receiptQty - inspectedTotal);
  const requireAcceptance = options.requireAcceptance ?? true;

  let qcAllowed = 0;
  let blockedReason: string | undefined;

  if (requireAcceptance) {
    if (remainingUninspected > 1e-6) {
      blockedReason = 'QC must be completed before putaway.';
    } else if (accept <= 1e-6) {
      // HOLD, REWORK, and DISCARDED qty are blocked; only accepted qty flows to putaway.
      blockedReason = hold > 1e-6
        ? 'Receipt line is on QC hold with no accepted quantity.'
        : 'Receipt line has no accepted quantity.';
    } else {
      // accept > 0: eligible quantity is the accepted fraction.
      // HOLD qty is excluded naturally because qcAllowed is capped at accept, not receiptQty.
      // REWORK and DISCARDED derive from HOLD (via hold_disposition_events) and are similarly excluded.
      qcAllowed = Math.min(Math.max(0, receiptQty - rejected), accept);
    }
  } else {
    const baseAvailable = Math.max(0, receiptQty - rejected);
    qcAllowed = baseAvailable;
    if (accept > 0) {
      qcAllowed = Math.min(qcAllowed, accept);
    } else if (hold > 0) {
      qcAllowed = 0;
      blockedReason = 'Receipt line is on QC hold with no accepted quantity.';
    }
  }

  const posted = roundQuantity(totals.posted ?? 0);
  const pending = Math.max(0, roundQuantity(totals.pending ?? 0) - roundQuantity(excludePendingQuantity));

  const remainingAfterPosted = Math.max(0, qcAllowed - posted);
  const availableForPlanning = Math.max(0, qcAllowed - posted - pending);

  if (availableForPlanning <= 0 && !blockedReason && remainingAfterPosted <= 0) {
    blockedReason = 'No remaining quantity available for putaway.';
  }

  return { availableForPlanning, remainingAfterPosted, blockedReason };
}

export function calculateAcceptedQuantity(
  quantityReceived: number,
  qcBreakdown: QcBreakdown,
  allowBaseOnReject = true
): number {
  const rejected = roundQuantity(qcBreakdown.reject ?? 0);
  const hold = roundQuantity(qcBreakdown.hold ?? 0);
  const accepted = roundQuantity(qcBreakdown.accept ?? 0);
  if (accepted > 0) {
    return accepted;
  }
  if (hold > 0) {
    return 0;
  }
  if (!allowBaseOnReject) {
    return 0;
  }
  return Math.max(0, roundQuantity(quantityReceived) - rejected);
}
