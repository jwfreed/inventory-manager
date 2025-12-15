import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query } from '../db';
import { qcEventSchema } from '../schemas/qc.schema';
import { roundQuantity, toNumber } from '../lib/numbers';

export type QcEventInput = z.infer<typeof qcEventSchema>;

function mapQcEvent(row: any) {
  return {
    id: row.id,
    purchaseOrderReceiptLineId: row.purchase_order_receipt_line_id,
    eventType: row.event_type,
    quantity: roundQuantity(toNumber(row.quantity)),
    uom: row.uom,
    reasonCode: row.reason_code,
    notes: row.notes,
    actorType: row.actor_type,
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
    createdAt: row.created_at
  };
}

export async function createQcEvent(data: QcEventInput) {
  const lineResult = await query(
    'SELECT id, uom, quantity_received FROM purchase_order_receipt_lines WHERE id = $1',
    [data.purchaseOrderReceiptLineId]
  );
  if (lineResult.rowCount === 0) {
    throw new Error('QC_LINE_NOT_FOUND');
  }
  const line = lineResult.rows[0];
  if (line.uom !== data.uom) {
    throw new Error('QC_UOM_MISMATCH');
  }

  const totalResult = await query(
    'SELECT COALESCE(SUM(quantity), 0) AS total FROM qc_events WHERE purchase_order_receipt_line_id = $1',
    [data.purchaseOrderReceiptLineId]
  );
  const currentTotal = roundQuantity(toNumber(totalResult.rows[0]?.total ?? 0));
  const lineQuantity = roundQuantity(toNumber(line.quantity_received));
  const newTotal = roundQuantity(currentTotal + data.quantity);
  if (newTotal - lineQuantity > 1e-6) {
    throw new Error('QC_EXCEEDS_RECEIPT');
  }

  const { rows } = await query(
    `INSERT INTO qc_events (
        id, purchase_order_receipt_line_id, event_type, quantity, uom, reason_code, notes, actor_type, actor_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      uuidv4(),
      data.purchaseOrderReceiptLineId,
      data.eventType,
      data.quantity,
      data.uom,
      data.reasonCode ?? null,
      data.notes ?? null,
      data.actorType,
      data.actorId ?? null
    ]
  );
  return mapQcEvent(rows[0]);
}

export async function listQcEventsForLine(lineId: string) {
  const lineResult = await query('SELECT id FROM purchase_order_receipt_lines WHERE id = $1', [lineId]);
  if (lineResult.rowCount === 0) {
    throw new Error('QC_LINE_NOT_FOUND');
  }
  const { rows } = await query(
    `SELECT * FROM qc_events
       WHERE purchase_order_receipt_line_id = $1
       ORDER BY occurred_at ASC`,
    [lineId]
  );
  return rows.map(mapQcEvent);
}
