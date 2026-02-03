import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import type { PoolClient } from 'pg';
import { query, withTransaction, withTransactionRetry } from '../db';
import {
  reservationsCreateSchema,
  reservationSchema,
  returnAuthorizationSchema,
  salesOrderSchema,
  shipmentSchema,
} from '../schemas/orderToCash.schema';
import { convertToCanonical, getCanonicalMovementFields } from './uomCanonical.service';
import { getItem } from './masterData.service';
import { applyInventoryBalanceDelta, getInventoryBalanceForUpdate } from '../domains/inventory';
import { resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import { beginIdempotency, completeIdempotency, hashRequestBody } from '../lib/idempotencyStore';
import { upsertBackorder } from './backorders.service';
import { roundQuantity, toNumber } from '../lib/numbers';
import { ItemLifecycleStatus } from '../types/item';
import { validateSufficientStock } from './stockValidation.service';
import {
  createInventoryMovement,
  createInventoryMovementLine,
  enqueueInventoryMovementPosted,
  enqueueInventoryReservationChanged
} from '../domains/inventory';
import { consumeCostLayers } from './costLayers.service';
import { recordAuditLog } from '../lib/audit';
import { atpCache, cacheKey } from '../lib/cache';

export type SalesOrderInput = z.infer<typeof salesOrderSchema>;
export type ReservationInput = z.infer<typeof reservationSchema>;
export type ReservationCreateInput = z.infer<typeof reservationsCreateSchema>;

const BACKORDERS_ENABLED = process.env.BACKORDERS_ENABLED !== 'false';

async function insertReservationEvent(
  client: any,
  tenantId: string,
  reservationId: string,
  eventType: 'RESERVED' | 'ALLOCATED' | 'CANCELLED' | 'EXPIRED' | 'FULFILLED',
  deltaReserved: number,
  deltaAllocated: number
) {
  await client.query(
    `INSERT INTO reservation_events (
        id, tenant_id, reservation_id, event_type, delta_reserved, delta_allocated, occurred_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
    [uuidv4(), tenantId, reservationId, eventType, deltaReserved, deltaAllocated]
  );
}

async function assertLocationSellable(
  client: PoolClient,
  tenantId: string,
  locationId: string
) {
  const res = await client.query<{ is_sellable: boolean }>(
    `SELECT is_sellable
       FROM locations
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, locationId]
  );
  if (res.rowCount === 0) {
    throw new Error('RESERVATION_LOCATION_NOT_FOUND');
  }
  if (!res.rows[0]?.is_sellable) {
    throw new Error('RESERVATION_LOCATION_NOT_SELLABLE');
  }
}
export type ShipmentInput = z.infer<typeof shipmentSchema>;
export type ReturnAuthorizationInput = z.infer<typeof returnAuthorizationSchema>;

function normalizeLineNumbers<T extends { lineNumber?: number }>(lines: T[]) {
  const lineNumbers = new Set<number>();
  return lines.map((line, idx) => {
    const ln = line.lineNumber ?? idx + 1;
    if (lineNumbers.has(ln)) {
      throw new Error('DUPLICATE_LINE_NUMBER');
    }
    lineNumbers.add(ln);
    return { ...line, lineNumber: ln };
  });
}

export function mapSalesOrder(row: any, lines: any[]) {
  return {
    id: row.id,
    soNumber: row.so_number,
    customerId: row.customer_id,
    status: row.status,
    orderDate: row.order_date,
    requestedShipDate: row.requested_ship_date,
    shipFromLocationId: row.ship_from_location_id,
    customerReference: row.customer_reference,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map((line) => ({
      id: line.id,
      salesOrderId: line.sales_order_id,
      lineNumber: line.line_number,
      itemId: line.item_id,
      uom: line.uom,
      quantityOrdered: line.quantity_ordered,
      unitPrice: line.unit_price != null ? Number(line.unit_price) : null,
      currencyCode: line.currency_code ?? null,
      exchangeRateToBase: line.exchange_rate_to_base != null ? Number(line.exchange_rate_to_base) : null,
      lineAmount: line.line_amount != null ? Number(line.line_amount) : null,
      baseAmount: line.base_amount != null ? Number(line.base_amount) : null,
      notes: line.notes,
      createdAt: line.created_at,
    })),
  };
}

export async function createSalesOrder(tenantId: string, data: SalesOrderInput) {
  const now = new Date();
  const id = uuidv4();
  const status = data.status ?? 'draft';
  const normalizedLines = normalizeLineNumbers(data.lines);

  return withTransaction(async (client) => {
    const orderResult = await client.query(
      `INSERT INTO sales_orders (
        id, tenant_id, so_number, customer_id, status, order_date, requested_ship_date,
        ship_from_location_id, customer_reference, notes, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
      RETURNING *`,
      [
        id,
        tenantId,
        data.soNumber,
        data.customerId,
        status,
        data.orderDate ?? null,
        data.requestedShipDate ?? null,
        data.shipFromLocationId ?? null,
        data.customerReference ?? null,
        data.notes ?? null,
        now,
      ],
    );

    const lines: any[] = [];
    for (const line of normalizedLines) {
      const item = await getItem(tenantId, line.itemId);
      if (!item) throw new Error(`ITEM_NOT_FOUND: ${line.itemId}`);
      if (item.lifecycleStatus !== ItemLifecycleStatus.ACTIVE) {
        throw new Error(`ITEM_NOT_ACTIVE: ${item.sku} is ${item.lifecycleStatus}`);
      }

      const lineResult = await client.query(
        `INSERT INTO sales_order_lines (
          id, tenant_id, sales_order_id, line_number, item_id, uom, quantity_ordered,
          unit_price, currency_code, exchange_rate_to_base, line_amount, base_amount, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *`,
        [
          uuidv4(),
          tenantId,
          id,
          line.lineNumber,
          line.itemId,
          line.uom,
          line.quantityOrdered,
          line.unitPrice ?? null,
          line.currencyCode ?? null,
          line.exchangeRateToBase ?? null,
          line.lineAmount ?? null,
          line.baseAmount ?? null,
          line.notes ?? null,
        ],
      );
      lines.push(lineResult.rows[0]);
    }

    return mapSalesOrder(orderResult.rows[0], lines);
  });
}

export async function getSalesOrder(tenantId: string, id: string) {
  const orderResult = await query('SELECT * FROM sales_orders WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (orderResult.rowCount === 0) return null;
  const lines = await query(
    'SELECT * FROM sales_order_lines WHERE sales_order_id = $1 AND tenant_id = $2 ORDER BY line_number ASC',
    [id, tenantId],
  );
  return mapSalesOrder(orderResult.rows[0], lines.rows);
}

export async function listSalesOrders(
  tenantId: string,
  limit: number,
  offset: number,
  filters: { status?: string; customerId?: string }
) {
  const params: any[] = [tenantId];
  const conditions: string[] = ['tenant_id = $1'];
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filters.customerId) {
    params.push(filters.customerId);
    conditions.push(`customer_id = $${params.length}`);
  }
  params.push(limit, offset);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT id, so_number, customer_id, status, order_date, requested_ship_date, ship_from_location_id,
            customer_reference, notes, created_at, updated_at
       FROM sales_orders
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

export function mapReservation(row: any) {
  return {
    id: row.id,
    status: row.status,
    state: row.status,
    demandType: row.demand_type,
    demandId: row.demand_id,
    itemId: row.item_id,
    locationId: row.location_id,
    warehouseId: row.warehouse_id,
    uom: row.uom,
    quantityReserved: row.quantity_reserved,
    quantityFulfilled: row.quantity_fulfilled,
    reservedAt: row.reserved_at,
    allocatedAt: row.allocated_at ?? row.released_at,
    canceledAt: row.canceled_at ?? null,
    fulfilledAt: row.fulfilled_at ?? null,
    expiredAt: row.expired_at ?? null,
    expiresAt: row.expires_at ?? null,
    cancelReason: row.cancel_reason ?? null,
    releaseReasonCode: row.release_reason_code,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createReservations(
  tenantId: string,
  data: ReservationCreateInput,
  options?: { idempotencyKey?: string | null }
) {
  const now = new Date();
  const baseIdempotency = options?.idempotencyKey ?? null;
  const results = await withTransactionRetry(async (client) => {
    const rows: any[] = [];
    for (const reservation of data.reservations) {
      const canonical = await convertToCanonical(
        tenantId,
        reservation.itemId,
        reservation.quantityReserved,
        reservation.uom,
        client
      );
      const idempotencyKey = baseIdempotency
        ? `${baseIdempotency}:${reservation.demandId}:${reservation.itemId}:${reservation.locationId}:${canonical.canonicalUom}`
        : null;
      if (idempotencyKey) {
        const existing = await client.query(
          `SELECT * FROM inventory_reservations
            WHERE client_id = $1 AND idempotency_key = $2`,
          [tenantId, idempotencyKey]
        );
        if (existing.rowCount > 0) {
          rows.push(existing.rows[0]);
          continue;
        }
      }

      await assertLocationSellable(client, tenantId, reservation.locationId);

      const balance = await getInventoryBalanceForUpdate(
        client,
        tenantId,
        reservation.itemId,
        reservation.locationId,
        canonical.canonicalUom
      );
      const available = roundQuantity(balance.onHand - balance.reserved - balance.allocated);
      let reserveQty = roundQuantity(Math.max(0, Math.min(canonical.quantity, available)));
      let backorderQty = roundQuantity(Math.max(0, canonical.quantity - reserveQty));
      // Tolerate tiny rounding drift so we don't reject valid reservations.
      if (backorderQty > 0 && backorderQty <= 1e-6) {
        backorderQty = 0;
        reserveQty = canonical.quantity;
      }
      const allowBackorder =
        reservation.allowBackorder !== undefined ? reservation.allowBackorder : BACKORDERS_ENABLED;

      if (backorderQty > 0 && !allowBackorder) {
        const err: any = new Error('RESERVATION_INSUFFICIENT_AVAILABLE');
        err.code = 'RESERVATION_INSUFFICIENT_AVAILABLE';
        throw err;
      }

      if (backorderQty > 0) {
        await upsertBackorder(
          tenantId,
          {
            demandType: reservation.demandType,
            demandId: reservation.demandId,
            itemId: reservation.itemId,
            locationId: reservation.locationId,
            uom: canonical.canonicalUom,
            quantity: backorderQty,
            notes: reservation.notes ?? null
          },
          client
        );
      }
      if (reserveQty <= 0) {
        continue;
      }
      const fulfilledQty =
        reservation.quantityFulfilled != null ? Math.min(reservation.quantityFulfilled, reserveQty) : 0;
      let warehouseId: string | null = null;
      try {
        warehouseId = await resolveWarehouseIdForLocation(tenantId, reservation.locationId, client);
      } catch (error) {
        warehouseId = null;
      }
      let res;
      try {
        res = await client.query(
          `INSERT INTO inventory_reservations (
            id, tenant_id, client_id, status, demand_type, demand_id, item_id, location_id, warehouse_id, uom,
            quantity_reserved, quantity_fulfilled, reserved_at, expires_at, notes, idempotency_key, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
          RETURNING *`,
          [
            uuidv4(),
            tenantId,
            tenantId,
            'RESERVED',
            reservation.demandType,
            reservation.demandId,
            reservation.itemId,
            reservation.locationId,
            warehouseId,
            canonical.canonicalUom,
            reserveQty,
            fulfilledQty,
            now,
            reservation.expiresAt ? new Date(reservation.expiresAt) : null,
            reservation.notes ?? null,
            idempotencyKey,
            now,
          ],
        );
      } catch (error: any) {
        if (error?.code === '23505') {
          if (idempotencyKey && error?.constraint === 'uq_inventory_reservations_idempotency_client') {
            const existing = await client.query(
              `SELECT * FROM inventory_reservations
                WHERE client_id = $1 AND idempotency_key = $2`,
              [tenantId, idempotencyKey]
            );
            if (existing.rowCount > 0) {
              rows.push(existing.rows[0]);
              continue;
            }
          }
          if (error?.constraint === 'inventory_reservations_unique') {
            const existing = await client.query(
              `SELECT * FROM inventory_reservations
                WHERE tenant_id = $1
                  AND demand_type = $2
                  AND demand_id = $3
                  AND item_id = $4
                  AND location_id = $5
                  AND uom = $6`,
              [
                tenantId,
                reservation.demandType,
                reservation.demandId,
                reservation.itemId,
                reservation.locationId,
                canonical.canonicalUom
              ]
            );
            if (existing.rowCount > 0) {
              rows.push(existing.rows[0]);
              continue;
            }
          }
        }
        throw error;
      }
      rows.push(res.rows[0]);

      await applyInventoryBalanceDelta(client, {
        tenantId,
        itemId: reservation.itemId,
        locationId: reservation.locationId,
        uom: canonical.canonicalUom,
        deltaReserved: reserveQty
      });

      await insertReservationEvent(client, tenantId, res.rows[0].id, 'RESERVED', reserveQty, 0);

      await enqueueInventoryReservationChanged(client, tenantId, res.rows[0].id, {
        itemId: reservation.itemId,
        locationId: reservation.locationId,
        demandId: reservation.demandId,
        demandType: reservation.demandType
      });
    }
    return rows;
  }, { isolationLevel: 'SERIALIZABLE', retries: 2 });
  atpCache.invalidate(cacheKey('atp', tenantId));
  return results.map(mapReservation);
}

export async function listReservations(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM inventory_reservations
     WHERE tenant_id = $1
     ORDER BY reserved_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  return rows.map(mapReservation);
}

export async function getReservation(tenantId: string, id: string) {
  const res = await query('SELECT * FROM inventory_reservations WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (res.rowCount === 0) return null;
  return mapReservation(res.rows[0]);
}

export async function allocateReservation(
  tenantId: string,
  id: string,
  options?: { idempotencyKey?: string | null }
) {
  const now = new Date();
  const result = await withTransactionRetry(async (client) => {
    const idempotencyKey = options?.idempotencyKey ?? null;
    if (idempotencyKey) {
      const record = await beginIdempotency(`reservation:${id}:allocate:${idempotencyKey}`, hashRequestBody({ id }), client);
      if (record.status === 'SUCCEEDED') {
        const res = await client.query('SELECT * FROM inventory_reservations WHERE id = $1 AND tenant_id = $2', [
          id,
          tenantId
        ]);
        return res.rowCount ? mapReservation(res.rows[0]) : null;
      }
      if (record.status === 'IN_PROGRESS' && !record.isNew) {
        throw new Error('RESERVATION_ALLOCATE_IN_PROGRESS');
      }
    }

    const reservationRes = await client.query(
      `SELECT * FROM inventory_reservations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [id, tenantId]
    );
    if (reservationRes.rowCount === 0) {
      throw new Error('RESERVATION_NOT_FOUND');
    }
    const reservation = reservationRes.rows[0];
    if (reservation.status === 'ALLOCATED' || reservation.status === 'FULFILLED') {
      if (idempotencyKey) {
        await completeIdempotency(`reservation:${id}:allocate:${idempotencyKey}`, 'SUCCEEDED', `reservation:${id}`, client);
      }
      return mapReservation(reservation);
    }
    if (reservation.status !== 'RESERVED') {
      throw new Error('RESERVATION_INVALID_TRANSITION');
    }

    const remaining = roundQuantity(
      Math.max(0, toNumber(reservation.quantity_reserved) - toNumber(reservation.quantity_fulfilled ?? 0))
    );
    if (remaining > 0) {
      await applyInventoryBalanceDelta(client, {
        tenantId,
        itemId: reservation.item_id,
        locationId: reservation.location_id,
        uom: reservation.uom,
        deltaReserved: -remaining,
        deltaAllocated: remaining
      });
    }

    await client.query(
      `UPDATE inventory_reservations
          SET status = 'ALLOCATED',
              allocated_at = COALESCE(allocated_at, $1),
              updated_at = $1
        WHERE id = $2 AND tenant_id = $3`,
      [now, id, tenantId]
    );

    if (remaining > 0) {
      await insertReservationEvent(client, tenantId, id, 'ALLOCATED', -remaining, remaining);
    }

    if (idempotencyKey) {
      await completeIdempotency(`reservation:${id}:allocate:${idempotencyKey}`, 'SUCCEEDED', `reservation:${id}`, client);
    }

    const updated = await client.query('SELECT * FROM inventory_reservations WHERE id = $1 AND tenant_id = $2', [
      id,
      tenantId
    ]);
    if (updated.rowCount > 0) {
      await enqueueInventoryReservationChanged(client, tenantId, updated.rows[0].id, {
        itemId: updated.rows[0].item_id,
        locationId: updated.rows[0].location_id,
        demandId: updated.rows[0].demand_id,
        demandType: updated.rows[0].demand_type
      });
    }
    return updated.rowCount ? mapReservation(updated.rows[0]) : null;
  }, { isolationLevel: 'SERIALIZABLE', retries: 2 });
  atpCache.invalidate(cacheKey('atp', tenantId));
  return result;
}

export async function cancelReservation(
  tenantId: string,
  id: string,
  params?: { reason?: string | null; idempotencyKey?: string | null }
) {
  const now = new Date();
  const allowAllocatedCancel = false;
  const result = await withTransactionRetry(async (client) => {
    const idempotencyKey = params?.idempotencyKey ?? null;
    if (idempotencyKey) {
      const record = await beginIdempotency(`reservation:${id}:cancel:${idempotencyKey}`, hashRequestBody({ id, reason: params?.reason ?? null }), client);
      if (record.status === 'SUCCEEDED') {
        const res = await client.query('SELECT * FROM inventory_reservations WHERE id = $1 AND tenant_id = $2', [
          id,
          tenantId
        ]);
        return res.rowCount ? mapReservation(res.rows[0]) : null;
      }
      if (record.status === 'IN_PROGRESS' && !record.isNew) {
        throw new Error('RESERVATION_CANCEL_IN_PROGRESS');
      }
    }

    const reservationRes = await client.query(
      `SELECT * FROM inventory_reservations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [id, tenantId]
    );
    if (reservationRes.rowCount === 0) {
      throw new Error('RESERVATION_NOT_FOUND');
    }
    const reservation = reservationRes.rows[0];
    if (['CANCELLED', 'EXPIRED', 'FULFILLED'].includes(reservation.status)) {
      if (idempotencyKey) {
        await completeIdempotency(`reservation:${id}:cancel:${idempotencyKey}`, 'SUCCEEDED', `reservation:${id}`, client);
      }
      return mapReservation(reservation);
    }

    const remaining = roundQuantity(
      Math.max(0, toNumber(reservation.quantity_reserved) - toNumber(reservation.quantity_fulfilled ?? 0))
    );
    if (reservation.status === 'RESERVED') {
      if (remaining > 0) {
        await applyInventoryBalanceDelta(client, {
          tenantId,
          itemId: reservation.item_id,
          locationId: reservation.location_id,
          uom: reservation.uom,
          deltaReserved: -remaining
        });
      }
      await insertReservationEvent(client, tenantId, id, 'CANCELLED', -remaining, 0);
    } else if (reservation.status === 'ALLOCATED') {
      if (!allowAllocatedCancel) {
        throw new Error('RESERVATION_ALLOCATED_CANCEL_FORBIDDEN');
      }
      if (remaining > 0) {
        await applyInventoryBalanceDelta(client, {
          tenantId,
          itemId: reservation.item_id,
          locationId: reservation.location_id,
          uom: reservation.uom,
          deltaAllocated: -remaining
        });
      }
      await insertReservationEvent(client, tenantId, id, 'CANCELLED', 0, -remaining);
    }

    await client.query(
      `UPDATE inventory_reservations
          SET status = 'CANCELLED',
              cancel_reason = $1,
              canceled_at = $2,
              updated_at = $2
        WHERE id = $3 AND tenant_id = $4`,
      [params?.reason ?? null, now, id, tenantId]
    );

    if (idempotencyKey) {
      await completeIdempotency(`reservation:${id}:cancel:${idempotencyKey}`, 'SUCCEEDED', `reservation:${id}`, client);
    }

    const updated = await client.query('SELECT * FROM inventory_reservations WHERE id = $1 AND tenant_id = $2', [
      id,
      tenantId
    ]);
    if (updated.rowCount > 0) {
      await enqueueInventoryReservationChanged(client, tenantId, updated.rows[0].id, {
        itemId: updated.rows[0].item_id,
        locationId: updated.rows[0].location_id,
        demandId: updated.rows[0].demand_id,
        demandType: updated.rows[0].demand_type
      });
    }
    return updated.rowCount ? mapReservation(updated.rows[0]) : null;
  }, { isolationLevel: 'SERIALIZABLE', retries: 2 });
  atpCache.invalidate(cacheKey('atp', tenantId));
  return result;
}

export async function fulfillReservation(
  tenantId: string,
  id: string,
  params?: { quantity?: number; idempotencyKey?: string | null }
) {
  const now = new Date();
  const result = await withTransactionRetry(async (client) => {
    const idempotencyKey = params?.idempotencyKey ?? null;
    if (idempotencyKey) {
      const record = await beginIdempotency(
        `reservation:${id}:fulfill:${idempotencyKey}`,
        hashRequestBody({ id, quantity: params?.quantity ?? null }),
        client
      );
      if (record.status === 'SUCCEEDED') {
        const res = await client.query('SELECT * FROM inventory_reservations WHERE id = $1 AND tenant_id = $2', [
          id,
          tenantId
        ]);
        return res.rowCount ? mapReservation(res.rows[0]) : null;
      }
      if (record.status === 'IN_PROGRESS' && !record.isNew) {
        throw new Error('RESERVATION_FULFILL_IN_PROGRESS');
      }
    }

    const reservationRes = await client.query(
      `SELECT * FROM inventory_reservations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [id, tenantId]
    );
    if (reservationRes.rowCount === 0) {
      throw new Error('RESERVATION_NOT_FOUND');
    }
    const reservation = reservationRes.rows[0];
    if (reservation.status === 'FULFILLED') {
      if (idempotencyKey) {
        await completeIdempotency(`reservation:${id}:fulfill:${idempotencyKey}`, 'SUCCEEDED', `reservation:${id}`, client);
      }
      return mapReservation(reservation);
    }
    if (reservation.status !== 'ALLOCATED') {
      throw new Error('RESERVATION_INVALID_TRANSITION');
    }

    const remaining = roundQuantity(
      Math.max(0, toNumber(reservation.quantity_reserved) - toNumber(reservation.quantity_fulfilled ?? 0))
    );
    const fulfillQty = params?.quantity != null ? Math.min(params.quantity, remaining) : remaining;
    if (fulfillQty > 0) {
      await applyInventoryBalanceDelta(client, {
        tenantId,
        itemId: reservation.item_id,
        locationId: reservation.location_id,
        uom: reservation.uom,
        deltaAllocated: -fulfillQty
      });
    }

    const fulfilledTotal = roundQuantity(toNumber(reservation.quantity_fulfilled ?? 0) + fulfillQty);
    const newStatus = fulfilledTotal + 1e-6 >= toNumber(reservation.quantity_reserved) ? 'FULFILLED' : 'ALLOCATED';
    await client.query(
      `UPDATE inventory_reservations
          SET quantity_fulfilled = $1,
              status = $2,
              fulfilled_at = CASE WHEN $2 = 'FULFILLED' THEN COALESCE(fulfilled_at, $3) ELSE fulfilled_at END,
              updated_at = $3
        WHERE id = $4 AND tenant_id = $5`,
      [fulfilledTotal, newStatus, now, id, tenantId]
    );

    if (fulfillQty > 0) {
      await insertReservationEvent(client, tenantId, id, 'FULFILLED', 0, -fulfillQty);
    }

    if (idempotencyKey) {
      await completeIdempotency(`reservation:${id}:fulfill:${idempotencyKey}`, 'SUCCEEDED', `reservation:${id}`, client);
    }

    const updated = await client.query('SELECT * FROM inventory_reservations WHERE id = $1 AND tenant_id = $2', [
      id,
      tenantId
    ]);
    if (updated.rowCount > 0) {
      await enqueueInventoryReservationChanged(client, tenantId, updated.rows[0].id, {
        itemId: updated.rows[0].item_id,
        locationId: updated.rows[0].location_id,
        demandId: updated.rows[0].demand_id,
        demandType: updated.rows[0].demand_type
      });
    }
    return updated.rowCount ? mapReservation(updated.rows[0]) : null;
  }, { isolationLevel: 'SERIALIZABLE', retries: 2 });
  atpCache.invalidate(cacheKey('atp', tenantId));
  return result;
}

export async function expireReservationsJob() {
  const now = new Date();
  const affectedTenants = new Set<string>();
  await withTransactionRetry(async (client) => {
    const res = await client.query(
      `SELECT id, tenant_id, item_id, location_id, uom, quantity_reserved, quantity_fulfilled
         FROM inventory_reservations
        WHERE status = 'RESERVED'
          AND expires_at IS NOT NULL
          AND expires_at <= now()
        FOR UPDATE SKIP LOCKED`
    );
    for (const row of res.rows) {
      affectedTenants.add(row.tenant_id);
      const remaining = roundQuantity(
        Math.max(0, toNumber(row.quantity_reserved) - toNumber(row.quantity_fulfilled ?? 0))
      );
      if (remaining > 0) {
        await applyInventoryBalanceDelta(client, {
          tenantId: row.tenant_id,
          itemId: row.item_id,
          locationId: row.location_id,
          uom: row.uom,
          deltaReserved: -remaining
        });
      }
      await client.query(
        `UPDATE inventory_reservations
            SET status = 'EXPIRED',
                expired_at = $1,
                updated_at = $1
          WHERE id = $2 AND tenant_id = $3`,
        [now, row.id, row.tenant_id]
      );
      await insertReservationEvent(client, row.tenant_id, row.id, 'EXPIRED', -remaining, 0);
    }
  }, { isolationLevel: 'SERIALIZABLE', retries: 1 });
  for (const tenantId of affectedTenants) {
    atpCache.invalidate(cacheKey('atp', tenantId));
  }
}

export function mapShipment(row: any, lines: any[]) {
  return {
    id: row.id,
    salesOrderId: row.sales_order_id,
    shippedAt: row.shipped_at,
    shipFromLocationId: row.ship_from_location_id,
    inventoryMovementId: row.inventory_movement_id,
    status: row.status ?? null,
    postedAt: row.posted_at ?? null,
    externalRef: row.external_ref,
    notes: row.notes,
    createdAt: row.created_at,
    lines: lines.map((line) => ({
      id: line.id,
      salesOrderShipmentId: line.sales_order_shipment_id,
      salesOrderLineId: line.sales_order_line_id,
      uom: line.uom,
      quantityShipped: line.quantity_shipped,
      createdAt: line.created_at,
    })),
  };
}

export async function createShipment(tenantId: string, data: ShipmentInput) {
  const now = new Date();
  const id = uuidv4();
  return withTransaction(async (client) => {
    const shipment = await client.query(
      `INSERT INTO sales_order_shipments (
        id, tenant_id, sales_order_id, shipped_at, ship_from_location_id, inventory_movement_id, external_ref, notes, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        id,
        tenantId,
        data.salesOrderId,
        data.shippedAt,
        data.shipFromLocationId ?? null,
        null,
        data.externalRef ?? null,
        data.notes ?? null,
        now,
      ],
    );

    const lines: any[] = [];
    for (const line of data.lines) {
      const lineResult = await client.query(
        `INSERT INTO sales_order_shipment_lines (
          id, tenant_id, sales_order_shipment_id, sales_order_line_id, uom, quantity_shipped
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *`,
        [uuidv4(), tenantId, id, line.salesOrderLineId, line.uom, line.quantityShipped],
      );
      lines.push(lineResult.rows[0]);
    }

    return mapShipment(shipment.rows[0], lines);
  });
}

export async function listShipments(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM sales_order_shipments
     WHERE tenant_id = $1
     ORDER BY shipped_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  return rows;
}

export async function getShipment(tenantId: string, id: string, client?: PoolClient) {
  const executor = client ? client.query.bind(client) : query;
  const shipment = await executor('SELECT * FROM sales_order_shipments WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
  ]);
  if (shipment.rowCount === 0) return null;
  const lines = await executor(
    'SELECT * FROM sales_order_shipment_lines WHERE sales_order_shipment_id = $1 AND tenant_id = $2 ORDER BY created_at ASC',
    [id, tenantId],
  );
  return mapShipment(shipment.rows[0], lines.rows);
}

export async function postShipment(
  tenantId: string,
  shipmentId: string,
  params: {
    idempotencyKey: string;
    actor?: { type: 'user' | 'system'; id?: string | null; role?: string | null };
    overrideRequested?: boolean;
    overrideReason?: string | null;
  }
) {
  if (!params.idempotencyKey) {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  }

  const result = await withTransactionRetry(async (client) => {
    const now = new Date();
    const shipmentRes = await client.query(
      `SELECT * FROM sales_order_shipments WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [shipmentId, tenantId]
    );
    if (shipmentRes.rowCount === 0) {
      throw new Error('SHIPMENT_NOT_FOUND');
    }
    const shipment = shipmentRes.rows[0];
    if (shipment.status === 'canceled') {
      throw new Error('SHIPMENT_CANCELED');
    }
    if (shipment.inventory_movement_id || shipment.status === 'posted') {
      return getShipment(tenantId, shipmentId, client);
    }
    if (!shipment.ship_from_location_id) {
      throw new Error('SHIPMENT_LOCATION_REQUIRED');
    }

    const linesRes = await client.query(
      `SELECT sosl.*, sol.item_id
         FROM sales_order_shipment_lines sosl
         JOIN sales_order_lines sol
           ON sol.id = sosl.sales_order_line_id
          AND sol.tenant_id = sosl.tenant_id
        WHERE sosl.sales_order_shipment_id = $1
          AND sosl.tenant_id = $2
        ORDER BY sosl.created_at ASC
        FOR UPDATE`,
      [shipmentId, tenantId]
    );
    if (linesRes.rowCount === 0) {
      throw new Error('SHIPMENT_NO_LINES');
    }

    const negativeLines = linesRes.rows.map((line) => ({
      itemId: line.item_id,
      locationId: shipment.ship_from_location_id,
      uom: line.uom,
      quantityToConsume: Math.abs(toNumber(line.quantity_shipped))
    }));

    const validation = await validateSufficientStock(
      tenantId,
      now,
      negativeLines,
      {
        actorId: params.actor?.id ?? null,
        actorRole: params.actor?.role ?? null,
        overrideRequested: params.overrideRequested,
        overrideReason: params.overrideReason ?? null,
        overrideReference: `shipment:${shipmentId}`
      },
      { client }
    );

    const movement = await createInventoryMovement(client, {
      tenantId,
      movementType: 'issue',
      status: 'posted',
      externalRef: `shipment:${shipmentId}`,
      idempotencyKey: params.idempotencyKey,
      occurredAt: shipment.shipped_at ?? now,
      postedAt: now,
      notes: shipment.notes ?? null,
      metadata: validation.overrideMetadata ?? null,
      createdAt: now,
      updatedAt: now
    });

    if (!movement.created) {
      const lineCheck = await client.query(
        `SELECT 1 FROM inventory_movement_lines WHERE movement_id = $1 LIMIT 1`,
        [movement.id]
      );
      if (lineCheck.rowCount > 0) {
        await client.query(
          `UPDATE sales_order_shipments
              SET inventory_movement_id = $1,
                  status = 'posted',
                  posted_at = COALESCE(posted_at, $2),
                  posted_idempotency_key = COALESCE(posted_idempotency_key, $3)
            WHERE id = $4 AND tenant_id = $5`,
          [movement.id, now, params.idempotencyKey, shipmentId, tenantId]
        );
        await enqueueInventoryMovementPosted(client, tenantId, movement.id);
        return getShipment(tenantId, shipmentId, client);
      }
    }

    for (const line of linesRes.rows) {
      const qtyShipped = toNumber(line.quantity_shipped);
      if (qtyShipped <= 0) {
        throw new Error('SHIPMENT_INVALID_QUANTITY');
      }

      const canonicalOut = await getCanonicalMovementFields(
        tenantId,
        line.item_id,
        -qtyShipped,
        line.uom,
        client
      );
      const issueQty = Math.abs(canonicalOut.quantityDeltaCanonical);

      const balance = await getInventoryBalanceForUpdate(
        client,
        tenantId,
        line.item_id,
        shipment.ship_from_location_id,
        canonicalOut.canonicalUom
      );
      const available = roundQuantity(balance.onHand - balance.reserved);
      if (available + 1e-6 < issueQty && !validation.overrideMetadata) {
        throw new Error('INSUFFICIENT_STOCK');
      }

      const reservationRes = await client.query(
        `SELECT * FROM inventory_reservations
          WHERE tenant_id = $1
            AND demand_type = 'sales_order_line'
            AND demand_id = $2
            AND item_id = $3
            AND location_id = $4
            AND uom = $5
            AND status IN ('RESERVED','ALLOCATED')
          FOR UPDATE`,
        [tenantId, line.sales_order_line_id, line.item_id, shipment.ship_from_location_id, canonicalOut.canonicalUom]
      );
      const reservation = reservationRes.rows[0] ?? null;
      const reservedRemaining = reservation
        ? roundQuantity(toNumber(reservation.quantity_reserved) - toNumber(reservation.quantity_fulfilled ?? 0))
        : 0;
      const reserveConsume = Math.min(issueQty, Math.max(0, reservedRemaining));

      const consumption = await consumeCostLayers({
        tenant_id: tenantId,
        item_id: line.item_id,
        location_id: shipment.ship_from_location_id,
        quantity: issueQty,
        consumption_type: 'sale',
        consumption_document_id: shipmentId,
        movement_id: movement.id,
        client
      });
      const unitCost = issueQty !== 0 ? consumption.total_cost / issueQty : null;
      const extendedCost = consumption.total_cost !== null ? -consumption.total_cost : null;

      await createInventoryMovementLine(client, {
        tenantId,
        movementId: movement.id,
        itemId: line.item_id,
        locationId: shipment.ship_from_location_id,
        quantityDelta: canonicalOut.quantityDeltaCanonical,
        uom: canonicalOut.canonicalUom,
        quantityDeltaEntered: canonicalOut.quantityDeltaEntered,
        uomEntered: canonicalOut.uomEntered,
        quantityDeltaCanonical: canonicalOut.quantityDeltaCanonical,
        canonicalUom: canonicalOut.canonicalUom,
        uomDimension: canonicalOut.uomDimension,
        unitCost,
        extendedCost,
        reasonCode: 'shipment',
        lineNotes: `Shipment ${shipmentId} line ${line.id}`
      });

      if (reservation && reserveConsume > 0 && reservation.status === 'RESERVED') {
        await applyInventoryBalanceDelta(client, {
          tenantId,
          itemId: line.item_id,
          locationId: shipment.ship_from_location_id,
          uom: canonicalOut.canonicalUom,
          deltaReserved: -reserveConsume,
          deltaAllocated: reserveConsume
        });
        await client.query(
          `UPDATE inventory_reservations
              SET status = 'ALLOCATED',
                  allocated_at = COALESCE(allocated_at, now()),
                  updated_at = now()
            WHERE id = $1 AND tenant_id = $2`,
          [reservation.id, tenantId]
        );
        await insertReservationEvent(client, tenantId, reservation.id, 'ALLOCATED', -reserveConsume, reserveConsume);
      }

      await applyInventoryBalanceDelta(client, {
        tenantId,
        itemId: line.item_id,
        locationId: shipment.ship_from_location_id,
        uom: canonicalOut.canonicalUom,
        deltaOnHand: -issueQty,
        deltaAllocated: -reserveConsume
      });

      if (reservation) {
        const fulfilled = roundQuantity(
          Math.min(
            toNumber(reservation.quantity_reserved),
            toNumber(reservation.quantity_fulfilled ?? 0) + reserveConsume
          )
        );
        const newStatus =
          fulfilled + 1e-6 >= toNumber(reservation.quantity_reserved) ? 'FULFILLED' : reservation.status;
        await client.query(
          `UPDATE inventory_reservations
              SET quantity_fulfilled = $1,
                  status = $2,
                  updated_at = now(),
                  fulfilled_at = CASE WHEN $2 = 'FULFILLED' THEN COALESCE(fulfilled_at, now()) ELSE fulfilled_at END
            WHERE id = $3 AND tenant_id = $4`,
          [fulfilled, newStatus, reservation.id, tenantId]
        );

        if (reserveConsume > 0) {
          await insertReservationEvent(
            client,
            tenantId,
            reservation.id,
            newStatus === 'FULFILLED' ? 'FULFILLED' : 'ALLOCATED',
            0,
            -reserveConsume
          );
        }

        await enqueueInventoryReservationChanged(client, tenantId, reservation.id, {
          itemId: reservation.item_id,
          locationId: reservation.location_id,
          demandId: reservation.demand_id,
          demandType: reservation.demand_type
        });
      }
    }

    await client.query(
      `UPDATE sales_order_shipments
          SET inventory_movement_id = $1,
              status = 'posted',
              posted_at = $2,
              posted_idempotency_key = $3
        WHERE id = $4 AND tenant_id = $5`,
      [movement.id, now, params.idempotencyKey, shipmentId, tenantId]
    );

    await enqueueInventoryMovementPosted(client, tenantId, movement.id);

    if (params.actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: params.actor.type,
          actorId: params.actor.id ?? null,
          action: 'post',
          entityType: 'sales_order_shipment',
          entityId: shipmentId,
          occurredAt: now,
          metadata: { movementId: movement.id }
        },
        client
      );
    }

    if (validation.overrideMetadata && params.actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: params.actor.type,
          actorId: params.actor.id ?? null,
          action: 'negative_override',
          entityType: 'inventory_movement',
          entityId: movement.id,
          occurredAt: now,
          metadata: {
            reason: validation.overrideMetadata.override_reason ?? null,
            reference: validation.overrideMetadata.override_reference ?? null,
            shipmentId
          }
        },
        client
      );
    }

    return getShipment(tenantId, shipmentId, client);
  }, { isolationLevel: 'SERIALIZABLE', retries: 2 });

  if (!result) {
    throw new Error('SHIPMENT_POST_FAILED');
  }
  return result;
}

export function mapReturnAuth(row: any, lines: any[]) {
  return {
    id: row.id,
    rmaNumber: row.rma_number,
    customerId: row.customer_id,
    salesOrderId: row.sales_order_id,
    status: row.status,
    severity: row.severity,
    authorizedAt: row.authorized_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map((line) => ({
      id: line.id,
      returnAuthorizationId: line.return_authorization_id,
      lineNumber: line.line_number,
      salesOrderLineId: line.sales_order_line_id,
      itemId: line.item_id,
      uom: line.uom,
      quantityAuthorized: line.quantity_authorized,
      reasonCode: line.reason_code,
      notes: line.notes,
      createdAt: line.created_at,
    })),
  };
}

export async function createReturnAuthorization(tenantId: string, data: ReturnAuthorizationInput) {
  const now = new Date();
  const id = uuidv4();
  const status = data.status ?? 'draft';
  const normalizedLines = normalizeLineNumbers(data.lines);

  return withTransaction(async (client) => {
    const header = await client.query(
      `INSERT INTO return_authorizations (
        id, tenant_id, rma_number, customer_id, sales_order_id, status, severity, authorized_at, notes, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
      RETURNING *`,
      [
        id,
        tenantId,
        data.rmaNumber,
        data.customerId,
        data.salesOrderId ?? null,
        status,
        data.severity ?? null,
        data.authorizedAt ?? null,
        data.notes ?? null,
        now,
      ],
    );

    const lines: any[] = [];
    for (const line of normalizedLines) {
      const lineResult = await client.query(
        `INSERT INTO return_authorization_lines (
          id, tenant_id, return_authorization_id, line_number, sales_order_line_id, item_id, uom, quantity_authorized, reason_code, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *`,
        [
          uuidv4(),
          tenantId,
          id,
          line.lineNumber,
          line.salesOrderLineId ?? null,
          line.itemId,
          line.uom,
          line.quantityAuthorized,
          line.reasonCode ?? null,
          line.notes ?? null,
        ],
      );
      lines.push(lineResult.rows[0]);
    }

    return mapReturnAuth(header.rows[0], lines);
  });
}

export async function listReturnAuthorizations(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM return_authorizations
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  return rows;
}

export async function getReturnAuthorization(tenantId: string, id: string) {
  const header = await query('SELECT * FROM return_authorizations WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
  ]);
  if (header.rowCount === 0) return null;
  const lines = await query(
    'SELECT * FROM return_authorization_lines WHERE return_authorization_id = $1 AND tenant_id = $2 ORDER BY line_number ASC',
    [id, tenantId],
  );
  return mapReturnAuth(header.rows[0], lines.rows);
}
