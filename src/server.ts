import express, { Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { pool, query, withTransaction } from './db';
import type { PoolClient } from 'pg';

const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json());

const vendorSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(32).optional()
});

const purchaseOrderLineSchema = z.object({
  lineNumber: z.number().int().positive().optional(),
  itemId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantityOrdered: z.number().positive(),
  notes: z.string().max(1000).optional()
});

const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO date format YYYY-MM-DD');

const purchaseOrderSchema = z.object({
  poNumber: z.string().min(1).max(64),
  vendorId: z.string().uuid(),
  status: z.enum(['draft', 'submitted']).optional(),
  orderDate: isoDateString.optional(),
  expectedDate: isoDateString.optional(),
  shipToLocationId: z.string().uuid().optional(),
  vendorReference: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(purchaseOrderLineSchema).min(1)
});

function mapPurchaseOrder(row: any, lines: any[]) {
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

app.post('/vendors', async (req: Request, res: Response) => {
  const parsed = vendorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const now = new Date();
  const id = uuidv4();

  try {
    const { rows } = await query(
      `INSERT INTO vendors (id, code, name, email, phone, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, true, $6, $6)
       RETURNING id, code, name, email, phone, active, created_at, updated_at`,
      [id, parsed.data.code, parsed.data.name, parsed.data.email ?? null, parsed.data.phone ?? null, now]
    );
    return res.status(201).json(rows[0]);
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'Vendor code must be unique.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create vendor.' });
  }
});

app.get('/vendors', async (_req: Request, res: Response) => {
  try {
    const { rows } = await query(
      'SELECT id, code, name, email, phone, active, created_at, updated_at FROM vendors ORDER BY created_at DESC'
    );
    return res.json({ data: rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list vendors.' });
  }
});

app.post('/purchase-orders', async (req: Request, res: Response) => {
  const parsed = purchaseOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const data = parsed.data;
  const poId = uuidv4();
  const now = new Date();
  const status = data.status ?? 'draft';

  const lineNumbers = new Set<number>();
  let hasDuplicateLineNumbers = false;
  const normalizedLines = data.lines.map((line, index) => {
    const number = line.lineNumber ?? index + 1;
    if (lineNumbers.has(number)) {
      hasDuplicateLineNumbers = true;
    }
    lineNumbers.add(number);
    return { ...line, lineNumber: number };
  });
  if (hasDuplicateLineNumbers) {
    return res.status(400).json({ error: 'Line numbers must be unique within a purchase order.' });
  }

  try {
    const purchaseOrder = await withTransaction(async (client: PoolClient) => {
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

    return res.status(201).json(purchaseOrder);
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'PO number must be unique.' });
    }
    if (error?.code === '23503') {
      return res.status(400).json({ error: 'Referenced vendor, item, or location does not exist.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create purchase order.' });
  }
});

app.get('/purchase-orders/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid purchase order id.' });
  }

  try {
    const poResult = await query('SELECT * FROM purchase_orders WHERE id = $1', [id]);
    if (poResult.rowCount === 0) {
      return res.status(404).json({ error: 'Purchase order not found.' });
    }

    const lineResult = await query(
      'SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY line_number ASC',
      [id]
    );

    return res.json(mapPurchaseOrder(poResult.rows[0], lineResult.rows));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch purchase order.' });
  }
});

app.get('/purchase-orders', async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  try {
    const { rows } = await query(
      `SELECT id, po_number, vendor_id, status, order_date, expected_date, ship_to_location_id,
              vendor_reference, notes, created_at, updated_at
         FROM purchase_orders
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return res.json({ data: rows, paging: { limit, offset } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list purchase orders.' });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error', err);
});

app.listen(PORT, () => {
  console.log(`Inventory Manager API listening on port ${PORT}`);
});
