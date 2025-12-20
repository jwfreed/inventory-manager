import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { purchaseOrderReceiptSchema } from '../schemas/receipts.schema';
import type { z } from 'zod';
import { defaultBreakdown, loadQcBreakdown } from './inbound/receivingAggregations';
import type { QcBreakdown } from './inbound/receivingAggregations';
import { roundQuantity, toNumber } from '../lib/numbers';
import { normalizeQuantityByUom } from '../lib/uom';
import { query as baseQuery } from '../db';
import { updatePoStatusFromReceipts } from './status/purchaseOrdersStatus.service';

type PurchaseOrderReceiptInput = z.infer<typeof purchaseOrderReceiptSchema>;

function buildQcSummary(lineId: string, breakdownMap: Map<string, QcBreakdown>, quantityReceived: number) {
  const breakdown = breakdownMap.get(lineId) ?? defaultBreakdown();
  const totalQcQuantity = roundQuantity(breakdown.hold + breakdown.accept + breakdown.reject);
  return {
    totalQcQuantity,
    breakdown,
    remainingUninspectedQuantity: roundQuantity(Math.max(0, quantityReceived - totalQcQuantity))
  };
}

function mapReceiptLine(line: any, qcBreakdown: Map<string, QcBreakdown>) {
  const quantityReceived = roundQuantity(toNumber(line.quantity_received));
  return {
    id: line.id,
    purchaseOrderReceiptId: line.purchase_order_receipt_id,
    purchaseOrderLineId: line.purchase_order_line_id,
    defaultFromLocationId: line.received_to_location_id ?? line.item_default_location_id ?? null,
    itemId: line.item_id,
    itemSku: line.item_sku ?? null,
    itemName: line.item_name ?? null,
    defaultToLocationId: line.item_default_location_id ?? null,
    uom: line.uom,
    quantityReceived,
    createdAt: line.created_at,
    qcSummary: buildQcSummary(line.id, qcBreakdown, quantityReceived)
  };
}

function mapReceipt(row: any, lineRows: any[], qcBreakdown: Map<string, QcBreakdown>) {
  return {
    id: row.id,
    purchaseOrderId: row.purchase_order_id,
    purchaseOrderNumber: row.po_number ?? null,
    receivedAt: row.received_at,
    receivedToLocationId: row.received_to_location_id,
    inventoryMovementId: row.inventory_movement_id,
    externalRef: row.external_ref,
    notes: row.notes,
    createdAt: row.created_at,
    lines: lineRows.map((line) => mapReceiptLine(line, qcBreakdown))
  };
}

export async function fetchReceiptById(id: string, client?: PoolClient) {
  const executor = client ?? query;
  const receiptResult = await executor(
    `SELECT por.*, po.po_number
       FROM purchase_order_receipts por
       LEFT JOIN purchase_orders po ON po.id = por.purchase_order_id
      WHERE por.id = $1`,
    [id]
  );
  if (receiptResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor(
    `SELECT porl.*,
            pol.item_id,
            i.sku AS item_sku,
            i.name AS item_name,
            i.default_location_id AS item_default_location_id
       FROM purchase_order_receipt_lines porl
       LEFT JOIN purchase_order_lines pol ON pol.id = porl.purchase_order_line_id
       LEFT JOIN items i ON i.id = pol.item_id
      WHERE porl.purchase_order_receipt_id = $1
      ORDER BY porl.created_at ASC`,
    [id]
  );
  const lineIds = linesResult.rows.map((line) => line.id);
  const breakdown = await loadQcBreakdown(lineIds, client);
  return mapReceipt(receiptResult.rows[0], linesResult.rows, breakdown);
}

export async function createPurchaseOrderReceipt(data: PurchaseOrderReceiptInput) {
  const receiptId = uuidv4();
  const uniqueSet = new Set(data.lines.map((line) => line.purchaseOrderLineId));
  const uniqueLineIds = Array.from(uniqueSet);

  const poResult = await query('SELECT status, ship_to_location_id FROM purchase_orders WHERE id = $1', [data.purchaseOrderId]);
  if (poResult.rowCount === 0) {
    throw new Error('RECEIPT_PO_NOT_FOUND');
  }
  const poRow = poResult.rows[0];
  if (['received', 'closed'].includes(poRow.status)) {
    throw new Error('RECEIPT_PO_ALREADY_RECEIVED');
  }

  const { rows: poLineRows } = await query(
    'SELECT id, purchase_order_id, uom FROM purchase_order_lines WHERE id = ANY($1::uuid[])',
    [uniqueLineIds]
  );
  if (poLineRows.length !== uniqueLineIds.length) {
    throw new Error('RECEIPT_PO_LINES_NOT_FOUND');
  }
  const poLineMap = new Map<string, { purchase_order_id: string; uom: string }>();
  for (const row of poLineRows) {
    poLineMap.set(row.id, { purchase_order_id: row.purchase_order_id, uom: row.uom });
  }
  for (const line of data.lines) {
    const poLine = poLineMap.get(line.purchaseOrderLineId);
    if (!poLine) {
      throw new Error('RECEIPT_LINE_INVALID_REFERENCE');
    }
    if (poLine.purchase_order_id !== data.purchaseOrderId) {
      throw new Error('RECEIPT_LINES_WRONG_PO');
    }
    if (poLine.uom !== line.uom) {
      throw new Error('RECEIPT_LINE_UOM_MISMATCH');
    }
  }

  // Default receiving location: prefer explicit provided, otherwise PO receiving/staging, otherwise dedicated receiving, otherwise ship-to.
  let resolvedReceivedToLocationId = data.receivedToLocationId ?? null;
  if (!resolvedReceivedToLocationId) {
    const receivingLoc = poRow.receiving_location_id ?? (await findDefaultReceivingLocation());
    resolvedReceivedToLocationId = receivingLoc ?? poRow.ship_to_location_id ?? null;
  }

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO purchase_order_receipts (
          id, purchase_order_id, received_at, received_to_location_id,
          inventory_movement_id, external_ref, notes
       ) VALUES ($1, $2, $3, $4, NULL, $5, $6)`,
      [
        receiptId,
        data.purchaseOrderId,
        new Date(data.receivedAt),
        resolvedReceivedToLocationId,
        data.externalRef ?? null,
        data.notes ?? null
      ]
    );

    for (const line of data.lines) {
      const normalized = normalizeQuantityByUom(line.quantityReceived, line.uom);
      await client.query(
        `INSERT INTO purchase_order_receipt_lines (
            id, purchase_order_receipt_id, purchase_order_line_id, uom, quantity_received
         ) VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), receiptId, line.purchaseOrderLineId, normalized.uom, normalized.quantity]
      );
    }
  });

  const receipt = await fetchReceiptById(receiptId);
  if (!receipt) {
    throw new Error('RECEIPT_NOT_FOUND_AFTER_CREATE');
  }
  await updatePoStatusFromReceipts(receipt.purchaseOrderId);
  return receipt;
}

export async function listReceipts(limit = 20, offset = 0) {
  const { rows } = await query(
    `SELECT por.id,
            por.purchase_order_id,
            po.po_number,
            por.received_at,
            por.received_to_location_id,
            por.inventory_movement_id,
            por.external_ref,
            por.notes,
            por.created_at
       FROM purchase_order_receipts por
       LEFT JOIN purchase_orders po ON po.id = por.purchase_order_id
       ORDER BY por.created_at DESC
       LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

export async function deleteReceipt(id: string) {
  const { rows: receiptLineIds } = await query(
    'SELECT id FROM purchase_order_receipt_lines WHERE purchase_order_receipt_id = $1',
    [id]
  );
  const lineIds = receiptLineIds.map((r) => r.id);
  if (lineIds.length > 0) {
    const { rows: putawayRefs } = await query(
      'SELECT id FROM putaway_lines WHERE purchase_order_receipt_line_id = ANY($1::uuid[])',
      [lineIds]
    );
    if (putawayRefs.length > 0) {
      throw new Error('RECEIPT_HAS_PUTAWAYS');
    }
  }
  await withTransaction(async (client) => {
    await client.query('DELETE FROM purchase_order_receipt_lines WHERE purchase_order_receipt_id = $1', [id]);
    await client.query('DELETE FROM purchase_order_receipts WHERE id = $1', [id]);
  });
}
async function findDefaultReceivingLocation(): Promise<string | null> {
  const { rows } = await baseQuery(
    `SELECT id
       FROM locations
      WHERE active = true
        AND (type = 'receiving' OR code ILIKE '%recv%' OR name ILIKE '%receiv%')
      ORDER BY created_at ASC
      LIMIT 1`,
  );
  return rows[0]?.id ?? null;
}
