import type { PoolClient } from 'pg';
import { query } from '../../db';

export type QcBreakdown = { hold: number; accept: number; reject: number };

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
};

function roundQuantity(value: number): number {
  return parseFloat(value.toFixed(6));
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (value === null || value === undefined) {
    return 0;
  }
  const num = Number(value);
  return Number.isNaN(num) ? 0 : num;
}

export function defaultBreakdown(): QcBreakdown {
  return { hold: 0, accept: 0, reject: 0 };
}

export async function loadReceiptLineContexts(
  lineIds: string[],
  client?: PoolClient
): Promise<Map<string, ReceiptLineContext>> {
  const map = new Map<string, ReceiptLineContext>();
  if (lineIds.length === 0) {
    return map;
  }
  const executor = client ?? query;
  const { rows } = await executor(
    `SELECT
        prl.id,
        prl.purchase_order_receipt_id,
        prl.quantity_received,
        prl.uom,
        pol.item_id,
        pol.purchase_order_id,
        por.received_to_location_id
     FROM purchase_order_receipt_lines prl
     JOIN purchase_order_lines pol ON pol.id = prl.purchase_order_line_id
     JOIN purchase_order_receipts por ON por.id = prl.purchase_order_receipt_id
     WHERE prl.id = ANY($1::uuid[])`,
    [lineIds]
  );
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      receiptId: row.purchase_order_receipt_id,
      purchaseOrderId: row.purchase_order_id,
      itemId: row.item_id,
      uom: row.uom,
      quantityReceived: roundQuantity(toNumber(row.quantity_received)),
      defaultFromLocationId: row.received_to_location_id
    });
  }
  return map;
}

export async function loadPutawayTotals(
  lineIds: string[],
  client?: PoolClient
): Promise<Map<string, PutawayTotals>> {
  const map = new Map<string, PutawayTotals>();
  if (lineIds.length === 0) {
    return map;
  }
  const executor = client ?? query;
  const { rows } = await executor(
    `SELECT
        purchase_order_receipt_line_id AS line_id,
        SUM(CASE WHEN status = 'completed' THEN COALESCE(quantity_moved, 0) ELSE 0 END) AS posted_qty,
        SUM(CASE WHEN status = 'pending' THEN COALESCE(quantity_planned, 0) ELSE 0 END) AS pending_qty
     FROM putaway_lines
     WHERE purchase_order_receipt_line_id = ANY($1::uuid[])
       AND status <> 'canceled'
     GROUP BY purchase_order_receipt_line_id`,
    [lineIds]
  );
  for (const row of rows) {
    map.set(row.line_id, {
      posted: roundQuantity(toNumber(row.posted_qty)),
      pending: roundQuantity(toNumber(row.pending_qty))
    });
  }
  return map;
}

export async function loadQcBreakdown(
  lineIds: string[],
  client?: PoolClient
): Promise<Map<string, QcBreakdown>> {
  const map = new Map<string, QcBreakdown>();
  if (lineIds.length === 0) {
    return map;
  }
  const executor = client ?? query;
  const { rows } = await executor(
    `SELECT purchase_order_receipt_line_id AS line_id, event_type, SUM(quantity) AS total_quantity
       FROM qc_events
       WHERE purchase_order_receipt_line_id = ANY($1::uuid[])
       GROUP BY purchase_order_receipt_line_id, event_type`,
    [lineIds]
  );
  for (const row of rows) {
    const lineId = row.line_id as string;
    const breakdown = map.get(lineId) ?? defaultBreakdown();
    const eventType = row.event_type as keyof QcBreakdown;
    breakdown[eventType] = roundQuantity(toNumber(row.total_quantity));
    map.set(lineId, breakdown);
  }
  return map;
}

export function calculatePutawayAvailability(
  context: ReceiptLineContext,
  qcBreakdown: QcBreakdown,
  totals: PutawayTotals,
  excludePendingQuantity = 0
) {
  const receiptQty = roundQuantity(context.quantityReceived);
  const rejected = roundQuantity(qcBreakdown.reject ?? 0);
  const hold = roundQuantity(qcBreakdown.hold ?? 0);
  const accept = roundQuantity(qcBreakdown.accept ?? 0);
  const baseAvailable = Math.max(0, receiptQty - rejected);

  let qcAllowed = baseAvailable;
  let blockedReason: string | undefined;
  if (accept > 0) {
    qcAllowed = Math.min(qcAllowed, accept);
  } else if (hold > 0) {
    qcAllowed = 0;
    blockedReason = 'Receipt line is on QC hold with no accepted quantity.';
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
