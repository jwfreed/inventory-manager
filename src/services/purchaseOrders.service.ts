import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import type { purchaseOrderSchema, purchaseOrderLineSchema } from '../schemas/purchaseOrders.schema';

export type PurchaseOrderInput = z.infer<typeof purchaseOrderSchema>;
export type PurchaseOrderLineInput = z.infer<typeof purchaseOrderLineSchema>;

export function mapPurchaseOrder(row: any, lines: any[]) {
  return {
    id: row.id,
    poNumber: row.po_number,
    vendorId: row.vendor_id,
    status: row.status,
    orderDate: row.order_date,
    expectedDate: row.expected_date,
    shipToLocationId: row.ship_to_location_id,
    vendorReference: row.vendor_reference,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map((line) => ({
      id: line.id,
      purchaseOrderId: line.purchase_order_id,
      lineNumber: line.line_number,
      itemId: line.item_id,
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
    return { ...line, lineNumber: number };
  });
  return normalized;
}

export async function createPurchaseOrder(data: PurchaseOrderInput) {
  const poId = uuidv4();
  const now = new Date();
  const status = data.status ?? 'draft';
  const normalizedLines = normalizePurchaseOrderLines(data.lines);

  return withTransaction(async (client) => {
    const insertedOrder = await client.query(
      `INSERT INTO purchase_orders (
          id, po_number, vendor_id, status, order_date, expected_date,
          ship_to_location_id, vendor_reference, notes, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       RETURNING *`,
      [
        poId,
        data.poNumber,
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

    const lineInserts = [];
    for (const line of normalizedLines) {
      const lineResult = await client.query(
        `INSERT INTO purchase_order_lines (
            id, purchase_order_id, line_number, item_id, uom, quantity_ordered, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
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
      lineInserts.push(lineResult.rows[0]);
    }

    return mapPurchaseOrder(insertedOrder.rows[0], lineInserts);
  });
}

export async function getPurchaseOrderById(id: string) {
  const poResult = await query('SELECT * FROM purchase_orders WHERE id = $1', [id]);
  if (poResult.rowCount === 0) {
    return null;
  }
  const lineResult = await query(
    'SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY line_number ASC',
    [id]
  );
  return mapPurchaseOrder(poResult.rows[0], lineResult.rows);
}

export async function listPurchaseOrders(limit: number, offset: number) {
  const { rows } = await query(
    `SELECT id, po_number, vendor_id, status, order_date, expected_date, ship_to_location_id,
            vendor_reference, notes, created_at, updated_at
       FROM purchase_orders
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}
