import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import type { shippingContainerSchema, shippingContainerItemSchema } from '../schemas/shippingContainers.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { hashTransactionalIdempotencyRequest, claimTransactionalIdempotency, finalizeTransactionalIdempotency } from '../lib/transactionalIdempotency';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import { roundQuantity, toNumber } from '../lib/numbers';
import { postShipment } from './orderToCash.service';

export type ShippingContainerInput = z.infer<typeof shippingContainerSchema>;
export type ShippingContainerItemInput = z.infer<typeof shippingContainerItemSchema>;
const SHIPPING_QUANTITY_EPSILON = 1e-6;

function normalizeUomForCompare(value: unknown) {
  return String(value ?? '').trim().toLowerCase();
}

function buildContainerContentKey(params: {
  salesOrderLineId: string;
  itemId: string;
  uom: string;
}) {
  return `${params.salesOrderLineId}:${params.itemId}:${normalizeUomForCompare(params.uom)}`;
}

function assertQuantitiesMatch(
  expected: Map<string, number>,
  actual: Map<string, number>
) {
  if (expected.size !== actual.size) {
    throw new Error('SHIPPING_CONTAINER_CONTENT_MISMATCH');
  }
  for (const [key, expectedQty] of expected.entries()) {
    const actualQty = actual.get(key);
    if (actualQty === undefined || Math.abs(expectedQty - actualQty) > SHIPPING_QUANTITY_EPSILON) {
      throw new Error('SHIPPING_CONTAINER_CONTENT_MISMATCH');
    }
  }
}

async function insertShippingContainerItem(
  client: PoolClient,
  tenantId: string,
  containerId: string,
  item: ShippingContainerItemInput
) {
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
  if (!item.pickTaskId) {
    throw new Error('PACK_PICK_TASK_REQUIRED');
  }

  const taskRes = await client.query(
    `SELECT status, quantity_picked, sales_order_line_id, item_id, uom
       FROM pick_tasks
      WHERE id = $1 AND tenant_id = $2
      FOR UPDATE`,
    [item.pickTaskId, tenantId]
  );
  if (taskRes.rowCount === 0) {
    throw new Error('PICK_TASK_NOT_FOUND');
  }

  const task = taskRes.rows[0];
  if (task.status !== 'picked') {
    throw new Error('PICK_TASK_NOT_PICKED');
  }
  if (task.sales_order_line_id && task.sales_order_line_id !== item.salesOrderLineId) {
    throw new Error('PACK_PICK_TASK_LINE_MISMATCH');
  }
  if (task.item_id !== item.itemId) {
    throw new Error('PACK_PICK_TASK_ITEM_MISMATCH');
  }
  if (normalizeUomForCompare(task.uom) !== normalizeUomForCompare(item.uom)) {
    throw new Error('PACK_PICK_TASK_UOM_MISMATCH');
  }

  const alreadyPackedRes = await client.query(
    `SELECT COALESCE(SUM(quantity), 0)::numeric AS already_packed
       FROM shipment_container_items
      WHERE tenant_id = $1
        AND pick_task_id = $2`,
    [tenantId, item.pickTaskId]
  );
  const alreadyPacked = roundQuantity(toNumber(alreadyPackedRes.rows[0]?.already_packed ?? 0));
  const quantityPicked = roundQuantity(toNumber(task.quantity_picked ?? 0));
  const quantityToPack = roundQuantity(toNumber(item.quantity));
  if (quantityToPack <= SHIPPING_QUANTITY_EPSILON) {
    throw new Error('PACK_INVALID_QUANTITY');
  }
  if (alreadyPacked + quantityToPack - quantityPicked > SHIPPING_QUANTITY_EPSILON) {
    throw new Error('PACK_QUANTITY_EXCEEDS_PICKED');
  }

  const res = await client.query(
    `INSERT INTO shipment_container_items (id, tenant_id, shipment_container_id, pick_task_id, sales_order_line_id, item_id, uom, quantity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      uuidv4(),
      tenantId,
      containerId,
      item.pickTaskId,
      item.salesOrderLineId,
      item.itemId,
      item.uom,
      quantityToPack,
    ],
  );
  return mapShippingContainerItem(res.rows[0]);
}

async function finalizeStandaloneShippingContainer(
  client: PoolClient,
  tenantId: string,
  containerId: string,
  idempotencyKey: string
) {
  const requestHash = hashTransactionalIdempotencyRequest({
    method: 'POST',
    endpoint: IDEMPOTENCY_ENDPOINTS.SHIPPING_CONTAINERS_SHIP,
    body: { containerId }
  });
  const claim = await claimTransactionalIdempotency(client, {
    tenantId,
    key: idempotencyKey,
    endpoint: IDEMPOTENCY_ENDPOINTS.SHIPPING_CONTAINERS_SHIP,
    requestHash
  });
  if (claim.replayed) {
    return claim.responseBody as ReturnType<typeof mapShippingContainer>;
  }

  const containerRes = await client.query(
    `SELECT * FROM shipment_containers WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [containerId, tenantId]
  );
  if (containerRes.rowCount === 0) {
    throw new Error('SHIPPING_CONTAINER_NOT_FOUND');
  }
  if (containerRes.rows[0].status !== 'sealed') {
    throw new Error('SHIPPING_CONTAINER_NOT_SEALED');
  }

  const now = new Date();
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

  const responseBody = mapShippingContainer(res.rows[0]);
  await finalizeTransactionalIdempotency(client, {
    tenantId,
    key: idempotencyKey,
    responseStatus: 200,
    responseBody
  });
  return responseBody;
}

async function lockAndValidateContainerShipment(
  client: PoolClient,
  tenantId: string,
  containerId: string,
  shipmentId: string,
  shipmentLines: any[]
) {
  const containerRes = await client.query(
    `SELECT * FROM shipment_containers WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [containerId, tenantId]
  );
  if (containerRes.rowCount === 0) {
    throw new Error('SHIPPING_CONTAINER_NOT_FOUND');
  }
  const container = containerRes.rows[0];
  if (container.sales_order_shipment_id !== shipmentId) {
    throw new Error('SHIPPING_CONTAINER_SHIPMENT_MISMATCH');
  }
  if (container.status !== 'sealed') {
    throw new Error('SHIPPING_CONTAINER_NOT_SEALED');
  }

  const itemsRes = await client.query(
    `SELECT *
       FROM shipment_container_items
      WHERE shipment_container_id = $1
        AND tenant_id = $2
      ORDER BY created_at ASC
      FOR UPDATE`,
    [containerId, tenantId]
  );
  if ((itemsRes.rowCount ?? 0) === 0) {
    throw new Error('SHIPPING_CONTAINER_EMPTY');
  }

  const packedByKey = new Map<string, number>();
  for (const row of itemsRes.rows) {
    if (!row.pick_task_id) {
      throw new Error('PACK_PICK_TASK_REQUIRED');
    }
    const key = buildContainerContentKey({
      salesOrderLineId: row.sales_order_line_id,
      itemId: row.item_id,
      uom: row.uom
    });
    packedByKey.set(key, roundQuantity((packedByKey.get(key) ?? 0) + toNumber(row.quantity)));
  }

  const shipmentByKey = new Map<string, number>();
  for (const line of shipmentLines) {
    const key = buildContainerContentKey({
      salesOrderLineId: line.sales_order_line_id,
      itemId: line.item_id,
      uom: line.uom
    });
    shipmentByKey.set(key, roundQuantity((shipmentByKey.get(key) ?? 0) + toNumber(line.quantity_shipped)));
  }

  assertQuantitiesMatch(shipmentByKey, packedByKey);
}

async function markContainerShippedInTransaction(
  client: PoolClient,
  tenantId: string,
  containerId: string,
  occurredAt: Date
) {
  const res = await client.query(
    `UPDATE shipment_containers
        SET status = 'shipped',
            shipped_at = COALESCE(shipped_at, $1),
            updated_at = $1
      WHERE id = $2
        AND tenant_id = $3
        AND status = 'sealed'
      RETURNING *`,
    [occurredAt, containerId, tenantId]
  );
  if ((res.rowCount ?? 0) === 0) {
    throw new Error('SHIPPING_CONTAINER_NOT_SEALED');
  }
  return mapShippingContainer(res.rows[0]);
}

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
      items = await Promise.all(data.items.map((item) => insertShippingContainerItem(client, tenantId, id, item)));
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
    return insertShippingContainerItem(client, tenantId, containerId, item);
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
  const containerRes = await query(
    `SELECT sc.*, sos.posted_idempotency_key
       FROM shipment_containers sc
       LEFT JOIN sales_order_shipments sos
         ON sos.id = sc.sales_order_shipment_id
        AND sos.tenant_id = sc.tenant_id
      WHERE sc.id = $1
        AND sc.tenant_id = $2`,
    [containerId, tenantId]
  );
  if ((containerRes.rowCount ?? 0) === 0) {
    throw new Error('SHIPPING_CONTAINER_NOT_FOUND');
  }
  const container = containerRes.rows[0];
  const idempotencyKey = params.idempotencyKey.trim();
  if (!idempotencyKey) {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  }
  if (container.status === 'shipped') {
    if (
      container.sales_order_shipment_id
      && container.posted_idempotency_key === idempotencyKey
    ) {
      const shippedContainer = await getShippingContainer(tenantId, containerId);
      if (!shippedContainer) {
        throw new Error('SHIPPING_CONTAINER_NOT_FOUND');
      }
      return shippedContainer;
    }
    throw new Error('SHIPPING_CONTAINER_NOT_SEALED');
  }
  if (container.status !== 'sealed') {
    throw new Error('SHIPPING_CONTAINER_NOT_SEALED');
  }

  if (container.sales_order_shipment_id) {
    await postShipment(tenantId, container.sales_order_shipment_id, {
      idempotencyKey,
      actor: params.actor,
      internalHooks: {
        onLoaded: async ({ client, shipment, shipmentLines }) => {
          await lockAndValidateContainerShipment(client, tenantId, containerId, shipment.id, shipmentLines);
        },
        afterPost: async ({ client, occurredAt }) => {
          await markContainerShippedInTransaction(client, tenantId, containerId, occurredAt);
        }
      }
    });
    const shippedContainer = await getShippingContainer(tenantId, containerId);
    if (!shippedContainer) {
      throw new Error('SHIPPING_CONTAINER_NOT_FOUND');
    }
    return shippedContainer;
  }

  return withTransaction(async (client) => {
    return finalizeStandaloneShippingContainer(client, tenantId, containerId, idempotencyKey);
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
