import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import type { pickBatchSchema, pickTaskSchema } from '../schemas/picking.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';

export type PickBatchInput = z.infer<typeof pickBatchSchema>;
export type PickTaskInput = z.infer<typeof pickTaskSchema>;

export function mapPickBatch(row: any) {
  return {
    id: row.id,
    status: row.status,
    pickType: row.pick_type,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapPickTask(row: any) {
  return {
    id: row.id,
    pickBatchId: row.pick_batch_id,
    status: row.status,
    inventoryReservationId: row.inventory_reservation_id,
    salesOrderLineId: row.sales_order_line_id,
    itemId: row.item_id,
    uom: row.uom,
    fromLocationId: row.from_location_id,
    quantityRequested: Number(row.quantity_requested),
    quantityPicked: row.quantity_picked !== null ? Number(row.quantity_picked) : null,
    pickedAt: row.picked_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createPickBatch(tenantId: string, data: PickBatchInput) {
  const now = new Date();
  const id = uuidv4();
  const status = data.status ?? 'draft';
  const res = await query(
    `INSERT INTO pick_batches (id, tenant_id, status, pick_type, notes, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING *`,
    [id, tenantId, status, data.pickType, data.notes ?? null, now]
  );
  return mapPickBatch(res.rows[0]);
}

export async function listPickBatches(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM pick_batches
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );
  return rows.map(mapPickBatch);
}

export async function getPickBatch(tenantId: string, id: string) {
  const res = await query('SELECT * FROM pick_batches WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (res.rowCount === 0) return null;
  return mapPickBatch(res.rows[0]);
}

export async function createPickTask(tenantId: string, data: PickTaskInput) {
  const now = new Date();
  const id = uuidv4();
  const status = data.status ?? 'pending';
  try {
    const res = await query(
      `INSERT INTO pick_tasks (
        id, tenant_id, pick_batch_id, status, inventory_reservation_id, sales_order_line_id,
        item_id, uom, from_location_id, quantity_requested, quantity_picked, picked_at, notes,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
      RETURNING *`,
      [
        id,
        tenantId,
        data.pickBatchId,
        status,
        data.inventoryReservationId ?? null,
        data.salesOrderLineId ?? null,
        data.itemId,
        data.uom,
        data.fromLocationId,
        data.quantityRequested,
        data.quantityPicked ?? null,
        data.pickedAt ?? null,
        data.notes ?? null,
        now
      ]
    );
    return mapPickTask(res.rows[0]);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({ status: 400, body: { error: 'Referenced batch, item, reservation, order line, or location not found.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid status or quantity.' } })
    });
    if (mapped) throw Object.assign(new Error(), { http: mapped });
    throw error;
  }
}

export async function createWave(tenantId: string, salesOrderIds: string[]) {
  return withTransaction(async (client) => {
    const now = new Date();
    const batchId = uuidv4();

    // 1. Create Pick Batch
    const batchRes = await client.query(
      `INSERT INTO pick_batches (id, tenant_id, status, pick_type, notes, created_at, updated_at)
       VALUES ($1, $2, 'draft', 'batch', $3, $4, $4)
       RETURNING *`,
      [batchId, tenantId, `Wave for ${salesOrderIds.length} orders`, now]
    );
    const batch = mapPickBatch(batchRes.rows[0]);

    // 2. Find reservations for these orders
    const reservationsRes = await client.query(
      `SELECT r.*, sol.sales_order_id
       FROM inventory_reservations r
       JOIN sales_order_lines sol ON r.demand_id = sol.id
       WHERE sol.sales_order_id = ANY($1)
       AND r.demand_type = 'sales_order_line'
       AND r.status = 'open'`,
      [salesOrderIds]
    );

    // 3. Create Pick Tasks for each reservation
    const tasks = [];
    for (const res of reservationsRes.rows) {
      const taskId = uuidv4();
      const taskRes = await client.query(
        `INSERT INTO pick_tasks (
          id, tenant_id, pick_batch_id, status, inventory_reservation_id, sales_order_line_id,
          item_id, uom, from_location_id, quantity_requested, quantity_picked, created_at, updated_at
        ) VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, 0, $10, $10)
        RETURNING *`,
        [
          taskId,
          tenantId,
          batchId,
          res.id, // inventory_reservation_id
          res.demand_id, // sales_order_line_id
          res.item_id,
          res.uom,
          res.location_id,
          res.quantity_reserved,
          now
        ]
      );
      tasks.push(mapPickTask(taskRes.rows[0]));
    }

    return { batch, tasks };
  });
}

export async function listPickTasks(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM pick_tasks
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );
  return rows.map(mapPickTask);
}

export async function getPickTask(tenantId: string, id: string) {
  const res = await query('SELECT * FROM pick_tasks WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (res.rowCount === 0) return null;
  return mapPickTask(res.rows[0]);
}
