import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import type { purchaseOrderSchema, purchaseOrderLineSchema } from '../schemas/purchaseOrders.schema';
import { normalizeQuantityByUom } from '../lib/uom';

export type PurchaseOrderInput = z.infer<typeof purchaseOrderSchema>;
export type PurchaseOrderLineInput = z.infer<typeof purchaseOrderLineSchema>;

export function mapPurchaseOrder(row: any, lines: any[]) {
  return {
    id: row.id,
    poNumber: row.po_number,
    vendorId: row.vendor_id,
    vendorCode: row.vendor_code ?? null,
    vendorName: row.vendor_name ?? null,
    status: row.status,
    orderDate: row.order_date,
    expectedDate: row.expected_date,
    shipToLocationId: row.ship_to_location_id,
    shipToLocationCode: row.ship_to_location_code ?? null,
    vendorReference: row.vendor_reference,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map((line) => ({
      id: line.id,
      purchaseOrderId: line.purchase_order_id,
      lineNumber: line.line_number,
      itemId: line.item_id,
      itemSku: line.item_sku ?? line.sku ?? null,
      itemName: line.item_name ?? null,
      uom: line.uom,
      quantityOrdered: line.quantity_ordered,
      notes: line.notes,
      createdAt: line.created_at
    }))
  };
}

function normalizePurchaseOrderLines(lines: PurchaseOrderLineInput[]) {
  const lineNumbers = new Set<number>();
  const normalized = lines.map((line, index) => {
    const number = line.lineNumber ?? index + 1;
    if (lineNumbers.has(number)) {
      throw new Error('PO_DUPLICATE_LINE_NUMBERS');
    }
    lineNumbers.add(number);
    const normalizedQty = normalizeQuantityByUom(line.quantityOrdered, line.uom);
    return { ...line, lineNumber: number, quantityOrdered: normalizedQty.quantity, uom: normalizedQty.uom };
  });
  return normalized;
}

async function generatePoNumber(client: PoolClient) {
  const { rows } = await client.query(`SELECT nextval('po_number_seq') AS seq`);
  const seq = Number(rows[0].seq ?? 0);
  const padded = String(seq).padStart(6, '0');
  return `PO-${padded}`;
}

async function loadLinesWithItems(client: PoolClient, poId: string) {
  const { rows } = await client.query(
    `SELECT pol.*, i.sku AS item_sku, i.name AS item_name
       FROM purchase_order_lines pol
       LEFT JOIN items i ON i.id = pol.item_id
      WHERE pol.purchase_order_id = $1
      ORDER BY pol.line_number ASC`,
    [poId]
  );
  return rows;
}

export async function createPurchaseOrder(data: PurchaseOrderInput) {
  const poId = uuidv4();
  const now = new Date();
  const status = data.status ?? 'draft';
  const normalizedLines = normalizePurchaseOrderLines(data.lines);

  return withTransaction(async (client) => {
    const poNumber = (data.poNumber ?? '').trim() || (await generatePoNumber(client));
    const insertedOrder = await client.query(
      `INSERT INTO purchase_orders (
          id, po_number, vendor_id, status, order_date, expected_date,
          ship_to_location_id, vendor_reference, notes, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       RETURNING *`,
      [
        poId,
        poNumber,
        data.vendorId,
        status,
        data.orderDate ?? null,
        data.expectedDate ?? null,
        data.shipToLocationId ?? null,
        data.vendorReference ?? null,
        data.notes ?? null,
        now
      ]
    );

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO purchase_order_lines (
            id, purchase_order_id, line_number, item_id, uom, quantity_ordered, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          uuidv4(),
          poId,
          line.lineNumber,
          line.itemId,
          line.uom,
          line.quantityOrdered,
          line.notes ?? null
        ]
      );
    }

    const enrichedLines = await loadLinesWithItems(client, poId);
    return mapPurchaseOrder(insertedOrder.rows[0], enrichedLines);
  });
}

export async function getPurchaseOrderById(id: string) {
  const poResult = await query('SELECT * FROM purchase_orders WHERE id = $1', [id]);
  if (poResult.rowCount === 0) {
    return null;
  }
  const lineResult = await query(
    `SELECT pol.*, i.sku AS item_sku, i.name AS item_name
       FROM purchase_order_lines pol
       LEFT JOIN items i ON i.id = pol.item_id
      WHERE pol.purchase_order_id = $1
      ORDER BY pol.line_number ASC`,
    [id]
  );
  return mapPurchaseOrder(poResult.rows[0], lineResult.rows);
}

export async function listPurchaseOrders(limit: number, offset: number) {
  const { rows } = await query(
    `SELECT po.id,
            po.po_number,
            po.vendor_id,
            v.code AS vendor_code,
            v.name AS vendor_name,
            po.status,
            po.order_date,
            po.expected_date,
            po.ship_to_location_id,
            loc.code AS ship_to_location_code,
            po.vendor_reference,
            po.notes,
            po.created_at,
            po.updated_at
       FROM purchase_orders po
       LEFT JOIN vendors v ON v.id = po.vendor_id
       LEFT JOIN locations loc ON loc.id = po.ship_to_location_id
       ORDER BY po.created_at DESC
       LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}
