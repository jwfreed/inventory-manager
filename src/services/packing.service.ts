import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import type { packSchema, packLineSchema } from '../schemas/packing.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';

export type PackInput = z.infer<typeof packSchema>;
export type PackLineInput = z.infer<typeof packLineSchema>;

export function mapPack(row: any, lines?: any[]) {
  return {
    id: row.id,
    status: row.status,
    salesOrderShipmentId: row.sales_order_shipment_id,
    packageRef: row.package_ref,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines?.map(mapPackLine)
  };
}

export function mapPackLine(row: any) {
  return {
    id: row.id,
    packId: row.pack_id,
    pickTaskId: row.pick_task_id,
    salesOrderLineId: row.sales_order_line_id,
    itemId: row.item_id,
    uom: row.uom,
    quantityPacked: Number(row.quantity_packed),
    createdAt: row.created_at
  };
}

export async function createPack(tenantId: string, data: PackInput) {
  const now = new Date();
  const id = uuidv4();
  const status = data.status ?? 'open';

  return withTransaction(async (client) => {
    const header = await client.query(
      `INSERT INTO packs (id, tenant_id, status, sales_order_shipment_id, package_ref, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING *`,
      [id, tenantId, status, data.salesOrderShipmentId, data.packageRef ?? null, data.notes ?? null, now]
    );

    let lines: any[] = [];
    if (data.lines && data.lines.length) {
      lines = await Promise.all(
        data.lines.map((line) =>
          client
            .query(
              `INSERT INTO pack_lines (id, tenant_id, pack_id, pick_task_id, sales_order_line_id, item_id, uom, quantity_packed)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               RETURNING *`,
              [
                uuidv4(),
                tenantId,
                id,
                line.pickTaskId ?? null,
                line.salesOrderLineId,
                line.itemId,
                line.uom,
                line.quantityPacked
              ]
            )
            .then((r) => r.rows[0]),
        ),
      )
    }

    return mapPack(header.rows[0], lines)
  })
}

export async function listPacks(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM packs
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  )
  return rows.map(mapPack)
}

export async function getPack(tenantId: string, id: string) {
  const header = await query('SELECT * FROM packs WHERE id = $1 AND tenant_id = $2', [id, tenantId])
  if (header.rowCount === 0) return null
  const lines = await query('SELECT * FROM pack_lines WHERE pack_id = $1 AND tenant_id = $2 ORDER BY created_at ASC', [
    id,
    tenantId
  ])
  return mapPack(header.rows[0], lines.rows)
}

export async function addPackLine(tenantId: string, packId: string, line: PackLineInput) {
  const res = await query(
    `INSERT INTO pack_lines (id, tenant_id, pack_id, pick_task_id, sales_order_line_id, item_id, uom, quantity_packed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      uuidv4(),
      tenantId,
      packId,
      line.pickTaskId ?? null,
      line.salesOrderLineId,
      line.itemId,
      line.uom,
      line.quantityPacked,
    ],
  )
  return mapPackLine(res.rows[0])
}

export async function deletePackLine(tenantId: string, packId: string, lineId: string) {
  const res = await query('DELETE FROM pack_lines WHERE id = $1 AND pack_id = $2 AND tenant_id = $3', [
    lineId,
    packId,
    tenantId
  ])
  return res.rowCount > 0
}

export function mapPackError(error: unknown) {
  const mapped = mapPgErrorToHttp(error, {
    foreignKey: () => ({ status: 400, body: { error: 'Referenced shipment, item, order line, location, or pick task not found.' } }),
    check: () => ({ status: 400, body: { error: 'Invalid status or quantity.' } }),
    unique: () => ({ status: 409, body: { error: 'Duplicate line constraint.' } }),
  })
  if (mapped) {
    const err: any = new Error('Pack error')
    err.http = mapped
    return err
  }
  return error
}
