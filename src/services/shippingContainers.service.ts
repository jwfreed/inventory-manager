import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import type { shippingContainerSchema, shippingContainerItemSchema } from '../schemas/shippingContainers.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { postShipment } from './orderToCash.service';

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
    shippedAt: row.shipped_at ?? null,
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
  return withTransaction(async (client) => {
    // Validate container is open
    const containerRes = await client.query(
      `SELECT status FROM shipment_containers WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [containerId, tenantId]
    );
    if (containerRes.rowCount === 0) {
      throw new Error('SHIPPING_CONTAINER_NOT_FOUND');
    }
    if (containerRes.rows[0].status !== 'open') {
      throw new Error('SHIPPING_CONTAINER_NOT_OPEN');
    }

    // Only picked inventory can be packed: validate pick task is picked
    if (item.pickTaskId) {
      const taskRes = await client.query(
        `SELECT status, quantity_picked FROM pick_tasks WHERE id = $1 AND tenant_id = $2`,
        [item.pickTaskId, tenantId]
      );
      if (taskRes.rowCount === 0) {
        throw new Error('PICK_TASK_NOT_FOUND');
      }
      if (taskRes.rows[0].status !== 'picked') {
        throw new Error('PICK_TASK_NOT_PICKED');
      }

      // Pack quantity integrity: total packed across ALL containers for this task ≤ quantity_picked
      const alreadyPackedRes = await client.query(
        `SELECT COALESCE(SUM(quantity), 0)::numeric AS already_packed
           FROM shipment_container_items
          WHERE tenant_id = $1
            AND pick_task_id = $2`,
        [tenantId, item.pickTaskId]
      );
      const alreadyPacked = Number(alreadyPackedRes.rows[0].already_packed);
      const quantityPicked = Number(taskRes.rows[0].quantity_picked ?? 0);
      if (alreadyPacked + Number(item.quantity) > quantityPicked) {
        throw new Error('PACK_QUANTITY_EXCEEDS_PICKED');
      }
    }

    const res = await client.query(
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
    );
    return mapShippingContainerItem(res.rows[0]);
  });
}

export async function sealShippingContainer(tenantId: string, containerId: string) {
  return withTransaction(async (client) => {
    const now = new Date();
    const containerRes = await client.query(
      `SELECT status FROM shipment_containers WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [containerId, tenantId]
    );
    if (containerRes.rowCount === 0) {
      throw new Error('SHIPPING_CONTAINER_NOT_FOUND');
    }
    if (containerRes.rows[0].status !== 'open') {
      throw new Error('SHIPPING_CONTAINER_NOT_OPEN');
    }
    const update = await client.query(
      `UPDATE shipment_containers
          SET status = 'sealed',
              updated_at = $1
        WHERE id = $2
          AND tenant_id = $3
          AND status = 'open'
        RETURNING *`,
      [now, containerId, tenantId]
    );
    if (update.rowCount === 0) {
      throw new Error('SHIPPING_CONTAINER_NOT_OPEN');
    }
    return mapShippingContainer(update.rows[0]);
  });
}

export async function shipContainer(
  tenantId: string,
  containerId: string,
  params: {
    idempotencyKey: string;
    actor?: { type: 'user' | 'system'; id?: string | null; role?: string | null };
  }
) {
  // 1. Read container status — must be sealed to proceed
  const containerRes = await query(
    `SELECT status, sales_order_shipment_id FROM shipment_containers WHERE id = $1 AND tenant_id = $2`,
    [containerId, tenantId]
  );
  if ((containerRes.rowCount ?? 0) === 0) {
    throw new Error('SHIPPING_CONTAINER_NOT_FOUND');
  }
  const container = containerRes.rows[0];
  if (container.status !== 'sealed') {
    throw new Error('SHIPPING_CONTAINER_NOT_SEALED');
  }

  // 2. Exit inventory via the linked shipment document (idempotent)
  if (container.sales_order_shipment_id) {
    await postShipment(tenantId, container.sales_order_shipment_id, {
      idempotencyKey: params.idempotencyKey,
      actor: params.actor
    });
  }

  // 3. Mark container shipped — conditional UPDATE is the double-ship guard
  const now = new Date();
  return withTransaction(async (client) => {
    const locked = await client.query(
      `SELECT status FROM shipment_containers WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [containerId, tenantId]
    );
    if ((locked.rowCount ?? 0) === 0 || locked.rows[0].status !== 'sealed') {
      throw new Error('SHIPPING_CONTAINER_NOT_SEALED');
    }
    const res = await client.query(
      `UPDATE shipment_containers
          SET status = 'shipped',
              shipped_at = $1,
              updated_at = $1
        WHERE id = $2
          AND tenant_id = $3
          AND status = 'sealed'
        RETURNING *`,
      [now, containerId, tenantId]
    );
    if ((res.rowCount ?? 0) === 0) {
      throw new Error('SHIPPING_CONTAINER_NOT_SEALED');
    }
    return mapShippingContainer(res.rows[0]);
  });
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
