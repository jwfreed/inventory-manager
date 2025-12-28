import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { qcEventSchema } from '../schemas/qc.schema';
import { roundQuantity, toNumber } from '../lib/numbers';
import { normalizeQuantityByUom } from '../lib/uom';

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

export async function createQcEvent(tenantId: string, data: QcEventInput) {
  return withTransaction(async (client) => {
    const lineResult = await client.query(
      `SELECT prl.id,
              prl.uom,
              prl.quantity_received,
              por.received_to_location_id,
              por.status AS receipt_status,
              pol.item_id
         FROM purchase_order_receipt_lines prl
         JOIN purchase_order_receipts por ON por.id = prl.purchase_order_receipt_id AND por.tenant_id = prl.tenant_id
         JOIN purchase_order_lines pol ON pol.id = prl.purchase_order_line_id AND pol.tenant_id = prl.tenant_id
        WHERE prl.id = $1 AND prl.tenant_id = $2
        FOR UPDATE`,
      [data.purchaseOrderReceiptLineId, tenantId]
    );
    if (lineResult.rowCount === 0) {
      throw new Error('QC_LINE_NOT_FOUND');
    }
    const line = lineResult.rows[0];
    if (line.receipt_status === 'voided') {
      throw new Error('QC_RECEIPT_VOIDED');
    }
    if (line.uom !== data.uom) {
      throw new Error('QC_UOM_MISMATCH');
    }

    const totalResult = await client.query(
      'SELECT COALESCE(SUM(quantity), 0) AS total FROM qc_events WHERE purchase_order_receipt_line_id = $1 AND tenant_id = $2',
      [data.purchaseOrderReceiptLineId, tenantId]
    );
    const normalized = normalizeQuantityByUom(data.quantity, data.uom);
    const currentTotal = roundQuantity(toNumber(totalResult.rows[0]?.total ?? 0));
    const lineQuantity = roundQuantity(toNumber(line.quantity_received));
    const newTotal = roundQuantity(currentTotal + normalized.quantity);
    if (newTotal - lineQuantity > 1e-6) {
      throw new Error('QC_EXCEEDS_RECEIPT');
    }

    const { rows } = await client.query(
      `INSERT INTO qc_events (
          id, tenant_id, purchase_order_receipt_line_id, event_type, quantity, uom, reason_code, notes, actor_type, actor_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        uuidv4(),
        tenantId,
        data.purchaseOrderReceiptLineId,
        data.eventType,
        normalized.quantity,
        normalized.uom,
        data.reasonCode ?? null,
        data.notes ?? null,
        data.actorType,
        data.actorId ?? null
      ]
    );
    const created = rows[0];

    if (data.eventType === 'accept') {
      let itemDefaultLocationId: string | null = null;
      if (line.item_id) {
        const itemResult = await client.query(
          'SELECT default_location_id FROM items WHERE id = $1 AND tenant_id = $2',
          [line.item_id, tenantId]
        );
        itemDefaultLocationId = itemResult.rows[0]?.default_location_id ?? null;
      }
      const locationId = line.received_to_location_id ?? itemDefaultLocationId ?? null;
      if (!locationId) {
        throw new Error('QC_ACCEPT_LOCATION_REQUIRED');
      }
      const now = new Date();
      const movementId = uuidv4();
      await client.query(
        `INSERT INTO inventory_movements (
            id, tenant_id, movement_type, status, external_ref, occurred_at, posted_at, notes, created_at, updated_at
         ) VALUES ($1, $2, 'receive', 'posted', $3, $4, $4, $5, $4, $4)`,
        [movementId, tenantId, `qc_accept:${created.id}`, now, `QC accept for receipt line ${line.id}`]
      );
      await client.query(
        `INSERT INTO inventory_movement_lines (
            id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom, reason_code, line_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'qc_release', $8)`,
        [
          uuidv4(),
          tenantId,
          movementId,
          line.item_id,
          locationId,
          normalized.quantity,
          normalized.uom,
          `QC accept ${normalized.quantity} ${normalized.uom}`
        ]
      );
      await client.query(
        `INSERT INTO qc_inventory_links (
            id, tenant_id, qc_event_id, inventory_movement_id, created_at
         ) VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), tenantId, created.id, movementId, now]
      );
    }

    return mapQcEvent(created);
  });
}

export async function listQcEventsForLine(tenantId: string, lineId: string) {
  const lineResult = await query('SELECT id FROM purchase_order_receipt_lines WHERE id = $1 AND tenant_id = $2', [
    lineId,
    tenantId
  ]);
  if (lineResult.rowCount === 0) {
    throw new Error('QC_LINE_NOT_FOUND');
  }
  const { rows } = await query(
    `SELECT * FROM qc_events
       WHERE purchase_order_receipt_line_id = $1 AND tenant_id = $2
       ORDER BY occurred_at ASC`,
    [lineId, tenantId]
  );
  return rows.map(mapQcEvent);
}
