import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query } from '../db';
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

export async function createPickBatch(data: PickBatchInput) {
  const now = new Date();
  const id = uuidv4();
  const status = data.status ?? 'draft';
  const res = await query(
    `INSERT INTO pick_batches (id, status, pick_type, notes, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING *`,
    [id, status, data.pickType, data.notes ?? null, now]
  );
  return mapPickBatch(res.rows[0]);
}

export async function listPickBatches(limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM pick_batches
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows.map(mapPickBatch);
}

export async function getPickBatch(id: string) {
  const res = await query('SELECT * FROM pick_batches WHERE id = $1', [id]);
  if (res.rowCount === 0) return null;
  return mapPickBatch(res.rows[0]);
}

export async function createPickTask(data: PickTaskInput) {
  const now = new Date();
  const id = uuidv4();
  const status = data.status ?? 'pending';
  try {
    const res = await query(
      `INSERT INTO pick_tasks (
        id, pick_batch_id, status, inventory_reservation_id, sales_order_line_id,
        item_id, uom, from_location_id, quantity_requested, quantity_picked, picked_at, notes,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
      RETURNING *`,
      [
        id,
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

export async function listPickTasks(limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM pick_tasks
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows.map(mapPickTask);
}

export async function getPickTask(id: string) {
  const res = await query('SELECT * FROM pick_tasks WHERE id = $1', [id]);
  if (res.rowCount === 0) return null;
  return mapPickTask(res.rows[0]);
}
