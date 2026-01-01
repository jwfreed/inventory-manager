import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import type { shippingContainerSchema, shippingContainerItemSchema } from '../schemas/shippingContainers.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';

export type ShippingContainerInput = z.infer<typeof shippingContainerSchema>;
export type ShippingContainerItemInput = z.infer<typeof shippingContainerItemSchema>;

export function mapShippingContainer(row: any, items?: any[]) {
  return {
    id: row.id,
    status: row.status,
    salesOrderShipmentId: row.sales_order_shipment_id,
    salesOrderId: row.sales_order_id,
    packageRef: row.package_ref,
    trackingNumber: row.tracking_number,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items?.map(mapShippingContainerItem)
  };
}

export function mapShippingContainerItem(row: any) {
  return {
    id: row.id,
    shippingContainerId: row.shipment_container_id,
    pickTaskId: row.pick_task_id,
    salesOrderLineId: row.sales_order_line_id,
    itemId: row.item_id,
    uom: row.uom,
    quantity: Number(row.quantity),
    createdAt: row.created_at
  };
}

export async function createShippingContainer(tenantId: string, data: ShippingContainerInput) {
  const now = new Date();
  const id = uuidv4();
  const status = data.status ?? 'open';

  return withTransaction(async (client) => {
    const header = await client.query(
      `INSERT INTO shipment_containers (id, tenant_id, status, sales_order_shipment_id, sales_order_id, package_ref, tracking_number, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       RETURNING *`,
      [
        id,
        tenantId,
        status,
        data.salesOrderShipmentId ?? null,
        data.salesOrderId ?? null,
        data.packageRef ?? null,
        data.trackingNumber ?? null,
        data.notes ?? null,
        now
      ]
    );

    let items: any[] = [];
    if (data.items && data.items.length) {
      items = await Promise.all(
        data.items.map((item) =>
          client
            .query(
              `INSERT INTO shipment_container_items (id, tenant_id, shipment_container_id, pick_task_id, sales_order_line_id, item_id, uom, quantity)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               RETURNING *`,
              [
                uuidv4(),
                tenantId,
                id,
                item.pickTaskId ?? null,
                item.salesOrderLineId,
                item.itemId,
                item.uom,
                item.quantity
              ]
            )
            .then((r) => r.rows[0]),
        ),
      )
    }

    return mapShippingContainer(header.rows[0], items)
  })
}

export async function listShippingContainers(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM shipment_containers
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  )
  return rows.map(row => mapShippingContainer(row))
}

export async function getShippingContainer(tenantId: string, id: string) {
  const header = await query('SELECT * FROM shipment_containers WHERE id = $1 AND tenant_id = $2', [id, tenantId])
  if (header.rowCount === 0) return null
  const items = await query('SELECT * FROM shipment_container_items WHERE shipment_container_id = $1 AND tenant_id = $2 ORDER BY created_at ASC', [
    id,
    tenantId
  ])
  return mapShippingContainer(header.rows[0], items.rows)
}

export async function addShippingContainerItem(tenantId: string, containerId: string, item: ShippingContainerItemInput) {
  const res = await query(
    `INSERT INTO shipment_container_items (id, tenant_id, shipment_container_id, pick_task_id, sales_order_line_id, item_id, uom, quantity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      uuidv4(),
      tenantId,
      containerId,
      item.pickTaskId ?? null,
      item.salesOrderLineId,
      item.itemId,
      item.uom,
      item.quantity,
    ],
  )
  return mapShippingContainerItem(res.rows[0])
}

export async function deleteShippingContainerItem(tenantId: string, containerId: string, itemId: string) {
  const res = await query('DELETE FROM shipment_container_items WHERE id = $1 AND shipment_container_id = $2 AND tenant_id = $3', [
    itemId,
    containerId,
    tenantId
  ])
  return (res.rowCount || 0) > 0
}

export function mapShippingContainerError(error: unknown) {
  const mapped = mapPgErrorToHttp(error, {
    foreignKey: () => ({ status: 400, body: { error: 'Referenced shipment, item, order line, location, or pick task not found.' } }),
    check: () => ({ status: 400, body: { error: 'Invalid status or quantity.' } }),
    unique: () => ({ status: 409, body: { error: 'Duplicate line constraint.' } }),
  })
  if (mapped) {
    const err: any = new Error('Shipping Container error')
    err.http = mapped
    return err
  }
  return error
}
