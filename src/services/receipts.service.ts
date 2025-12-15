import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { purchaseOrderReceiptSchema } from '../schemas/receipts.schema';
import type { z } from 'zod';
import { defaultBreakdown, loadQcBreakdown } from './inbound/receivingAggregations';
import type { QcBreakdown } from './inbound/receivingAggregations';
import { roundQuantity, toNumber } from '../lib/numbers';

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
  const receiptResult = await executor('SELECT * FROM purchase_order_receipts WHERE id = $1', [id]);
  if (receiptResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor(
    'SELECT * FROM purchase_order_receipt_lines WHERE purchase_order_receipt_id = $1 ORDER BY created_at ASC',
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
        data.receivedToLocationId ?? null,
        data.externalRef ?? null,
        data.notes ?? null
      ]
    );

    for (const line of data.lines) {
      await client.query(
        `INSERT INTO purchase_order_receipt_lines (
            id, purchase_order_receipt_id, purchase_order_line_id, uom, quantity_received
         ) VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), receiptId, line.purchaseOrderLineId, line.uom, line.quantityReceived]
      );
    }
  });

  const receipt = await fetchReceiptById(receiptId);
  if (!receipt) {
    throw new Error('RECEIPT_NOT_FOUND_AFTER_CREATE');
  }
  return receipt;
}
