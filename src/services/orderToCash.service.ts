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
import {
  applyInventoryBalanceDelta,
  ensureInventoryBalanceRowAndLock,
  getInventoryBalanceForUpdate
} from '../domains/inventory';
import { resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import { getSellableSupplyMap } from './atp.service';
import { beginIdempotency, completeIdempotency, hashRequestBody } from '../lib/idempotencyStore';
import { upsertBackorder } from './backorders.service';
import { roundQuantity, toNumber } from '../lib/numbers';
import { ItemLifecycleStatus } from '../types/item';
import { validateSufficientStock, type StockValidationResult } from './stockValidation.service';
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
type ReservationCreateLine = ReservationCreateInput['reservations'][number];
type PreparedReservationCreateLine = {
  reservation: ReservationCreateLine;
  canonicalQuantity: number;
  canonicalUom: string;
};
type ReservationRow = {
  id: string;
  tenant_id: string;
  warehouse_id: string;
  status: string;
  item_id: string;
  location_id: string;
  uom: string;
  quantity_reserved: string | number;
  quantity_fulfilled: string | number | null;
  demand_id: string;
  demand_type: string;
};

const BACKORDERS_ENABLED = process.env.BACKORDERS_ENABLED !== 'false';

function compareReservationLockKey(
  left: PreparedReservationCreateLine,
  right: PreparedReservationCreateLine
): number {
  const itemCompare = left.reservation.itemId.localeCompare(right.reservation.itemId);
  if (itemCompare !== 0) return itemCompare;
  const locationCompare = left.reservation.locationId.localeCompare(right.reservation.locationId);
  if (locationCompare !== 0) return locationCompare;
  const uomCompare = left.canonicalUom.toLowerCase().localeCompare(right.canonicalUom.toLowerCase());
  if (uomCompare !== 0) return uomCompare;
  const demandCompare = left.reservation.demandId.localeCompare(right.reservation.demandId);
  if (demandCompare !== 0) return demandCompare;
  return left.reservation.demandType.localeCompare(right.reservation.demandType);
}

function reservationInvalidState() {
  return new Error('RESERVATION_INVALID_STATE');
}

function reservationInvalidQuantity() {
  return new Error('RESERVATION_INVALID_QUANTITY');
}

function insufficientAvailableWithAllowance(details?: Record<string, unknown>) {
  const error = new Error('Insufficient available inventory for shipment') as Error & {
    code?: string;
    status?: number;
    details?: Record<string, unknown>;
  };
  error.code = 'INSUFFICIENT_AVAILABLE_WITH_ALLOWANCE';
  error.status = 409;
  if (details) {
    error.details = details;
  }
  return error;
}

/*
 * Reservation Consumption Allowance Policy:
 * This is the ONLY allowed deviation from strict canonical availability checks.
 * Shipment posting may add the quantity consumed from the matched reservation
 * because that shipment consumes the same commitment in the same transaction.
 * No other code path may apply allowances to canonical availability.
 */
function canShipWithReservationAllowance(
  available: number,
  reserveConsume: number,
  shipQty: number
): boolean {
  return available + reserveConsume >= shipQty;
}

async function lockReservationsForUpdate(
  client: PoolClient,
  tenantId: string,
  warehouseId: string,
  reservationIds: string[]
) {
  const uniqueSortedIds = Array.from(new Set(reservationIds)).sort((a, b) => a.localeCompare(b));
  if (uniqueSortedIds.length === 0) {
    return [];
  }
  const res = await client.query<ReservationRow>(
    `SELECT * FROM inventory_reservations
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND id = ANY($3::uuid[])
      ORDER BY id ASC
      FOR UPDATE`,
    [tenantId, warehouseId, uniqueSortedIds]
  );
  return res.rows;
}

async function lockReservationForUpdate(
  client: PoolClient,
  tenantId: string,
  reservationId: string,
  warehouseId: string
) {
  const rows = await lockReservationsForUpdate(client, tenantId, warehouseId, [reservationId]);
  if (rows.length === 0) {
    throw new Error('RESERVATION_NOT_FOUND');
  }
  return rows[0];
}

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

async function getCanonicalAvailability(
  client: PoolClient,
  tenantId: string,
  warehouseId: string,
  itemId: string,
  locationId: string,
  uom: string
) {
  const res = await client.query(
    `SELECT on_hand_qty, reserved_qty, allocated_qty, available_qty
       FROM inventory_available_location_v
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND item_id = $3
        AND location_id = $4
        AND uom = $5
      LIMIT 1`,
    [tenantId, warehouseId, itemId, locationId, uom]
  );
  const row = res.rows[0];
  return {
    onHand: toNumber(row?.on_hand_qty ?? 0),
    reserved: toNumber(row?.reserved_qty ?? 0),
    allocated: toNumber(row?.allocated_qty ?? 0),
    available: toNumber(row?.available_qty ?? 0)
  };
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

export function mapSalesOrder(row: any, lines: any[], derivedBackorders?: Map<string, number>) {
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
      derivedBackorderQty: derivedBackorders?.get(line.id) ?? 0,
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

async function computeDerivedBackorders(tenantId: string, orderRow: any, lines: any[]) {
  if (!lines.length) return new Map<string, number>();
  const itemIds = Array.from(new Set(lines.map((line) => line.item_id)));
  const locationId = orderRow.ship_from_location_id ?? undefined;
  const warehouseId = locationId
    ? await resolveWarehouseIdForLocation(tenantId, locationId)
    : null;
  const supplyMap = warehouseId
    ? await getSellableSupplyMap(tenantId, { warehouseId, itemIds, locationId })
    : new Map<string, { onHand: number; reserved: number; allocated: number; available: number }>();

  const shippedRows = await query(
    `SELECT sol.id AS line_id,
            sol.item_id,
            sosl.uom,
            SUM(sosl.quantity_shipped) AS quantity_shipped
       FROM sales_order_shipment_lines sosl
       JOIN sales_order_shipments sos
         ON sos.id = sosl.sales_order_shipment_id
        AND sos.tenant_id = sosl.tenant_id
       JOIN sales_order_lines sol
         ON sol.id = sosl.sales_order_line_id
        AND sol.tenant_id = sosl.tenant_id
      WHERE sos.tenant_id = $1
        AND sos.sales_order_id = $2
      GROUP BY sol.id, sol.item_id, sosl.uom`,
    [tenantId, orderRow.id],
  );
  const shippedByLine = new Map<string, number>();
  for (const row of shippedRows.rows) {
    const canonical = await convertToCanonical(
      tenantId,
      row.item_id,
      Number(row.quantity_shipped),
      row.uom
    );
    const prev = shippedByLine.get(row.line_id) ?? 0;
    shippedByLine.set(row.line_id, roundQuantity(prev + canonical.quantity));
  }

  const derived = new Map<string, number>();
  for (const line of lines) {
    const ordered = await convertToCanonical(
      tenantId,
      line.item_id,
      Number(line.quantity_ordered),
      line.uom
    );
    const shipped = shippedByLine.get(line.id) ?? 0;
    const openDemand = roundQuantity(Math.max(0, ordered.quantity - shipped));
    const supplyKey = `${line.item_id}:${ordered.canonicalUom}`;
    const supply = supplyMap.get(supplyKey) ?? { onHand: 0, reserved: 0, allocated: 0, available: 0 };
    const fulfillable = roundQuantity(Math.max(0, supply.available));
    const backorder = roundQuantity(Math.max(0, openDemand - fulfillable));
    derived.set(line.id, backorder);
  }
  return derived;
}

export async function createSalesOrder(tenantId: string, data: SalesOrderInput) {
  const now = new Date();
  const id = uuidv4();
  const status = data.status ?? 'draft';
  const normalizedLines = normalizeLineNumbers(data.lines);

  const result = await withTransaction(async (client) => {
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

    return { order: orderResult.rows[0], lines };
  });
  const derivedBackorders = await computeDerivedBackorders(tenantId, result.order, result.lines);
  return mapSalesOrder(result.order, result.lines, derivedBackorders);
}

export async function getSalesOrder(tenantId: string, id: string) {
  const orderResult = await query('SELECT * FROM sales_orders WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (orderResult.rowCount === 0) return null;
  const lines = await query(
    'SELECT * FROM sales_order_lines WHERE sales_order_id = $1 AND tenant_id = $2 ORDER BY line_number ASC',
    [id, tenantId],
  );
  const derivedBackorders = await computeDerivedBackorders(tenantId, orderResult.rows[0], lines.rows);
  return mapSalesOrder(orderResult.rows[0], lines.rows, derivedBackorders);
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
    const preparedLines: PreparedReservationCreateLine[] = [];
    for (const reservation of data.reservations) {
      const canonical = await convertToCanonical(
        tenantId,
        reservation.itemId,
        reservation.quantityReserved,
        reservation.uom,
        client
      );
      preparedLines.push({
        reservation,
        canonicalQuantity: roundQuantity(canonical.quantity),
        canonicalUom: canonical.canonicalUom
      });
    }
    preparedLines.sort(compareReservationLockKey);

    for (const line of preparedLines) {
      const { reservation, canonicalQuantity, canonicalUom } = line;
      const idempotencyKey = baseIdempotency
        ? `${baseIdempotency}:${reservation.demandId}:${reservation.itemId}:${reservation.locationId}:${reservation.warehouseId}:${canonicalUom}`
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
      const warehouseId = await resolveWarehouseIdForLocation(tenantId, reservation.locationId, client);
      if (!warehouseId) {
        throw new Error('RESERVATION_WAREHOUSE_REQUIRED');
      }
      if (warehouseId !== reservation.warehouseId) {
        throw new Error('RESERVATION_WAREHOUSE_MISMATCH');
      }

      const allowBackorder =
        reservation.allowBackorder !== undefined ? reservation.allowBackorder : BACKORDERS_ENABLED;
      await ensureInventoryBalanceRowAndLock(
        client,
        tenantId,
        reservation.itemId,
        reservation.locationId,
        canonicalUom
      );

      let reserveQty = canonicalQuantity;
      let backorderQty = 0;
      if (allowBackorder) {
        const availability = await getCanonicalAvailability(
          client,
          tenantId,
          warehouseId,
          reservation.itemId,
          reservation.locationId,
          canonicalUom
        );
        const available = roundQuantity(availability.available);
        reserveQty = roundQuantity(Math.max(0, Math.min(canonicalQuantity, available)));
        backorderQty = roundQuantity(Math.max(0, canonicalQuantity - reserveQty));
      }
      // Tolerate tiny rounding drift so we don't reject valid reservations.
      if (backorderQty > 0 && backorderQty <= 1e-6) {
        backorderQty = 0;
        reserveQty = canonicalQuantity;
      }
      if (backorderQty > 0) {
        await upsertBackorder(
          tenantId,
          {
            demandType: reservation.demandType,
            demandId: reservation.demandId,
            itemId: reservation.itemId,
            locationId: reservation.locationId,
            uom: canonicalUom,
            quantity: backorderQty,
            notes: reservation.notes ?? null
          },
          client
        );
      }
      if (reserveQty <= 0) {
        continue;
      }
      if (!allowBackorder) {
        const availability = await getCanonicalAvailability(
          client,
          tenantId,
          warehouseId,
          reservation.itemId,
          reservation.locationId,
          canonicalUom
        );
        const available = roundQuantity(availability.available);
        if (available + 1e-6 < reserveQty) {
          const err: any = new Error('RESERVATION_INSUFFICIENT_AVAILABLE');
          err.code = 'RESERVATION_INSUFFICIENT_AVAILABLE';
          throw err;
        }
      }
      const fulfilledQty =
        reservation.quantityFulfilled != null ? Math.min(reservation.quantityFulfilled, reserveQty) : 0;
      const res = await client.query(
        `INSERT INTO inventory_reservations (
          id, tenant_id, client_id, status, demand_type, demand_id, item_id, location_id, warehouse_id, uom,
          quantity_reserved, quantity_fulfilled, reserved_at, expires_at, notes, idempotency_key, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
        ON CONFLICT DO NOTHING
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
          canonicalUom,
          reserveQty,
          fulfilledQty,
          now,
          reservation.expiresAt ? new Date(reservation.expiresAt) : null,
          reservation.notes ?? null,
          idempotencyKey,
          now,
        ],
      );
      if (res.rowCount === 0) {
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
            canonicalUom
          ]
        );
        if (existing.rowCount > 0) {
          rows.push(existing.rows[0]);
          continue;
        }
        throw new Error('RESERVATION_CONFLICT');
      }
      rows.push(res.rows[0]);
      await client.query(
        `UPDATE inventory_balance
            SET reserved = reserved + $1,
                updated_at = now()
          WHERE tenant_id = $2
            AND item_id = $3
            AND location_id = $4
            AND uom = $5`,
        [
          reserveQty,
          tenantId,
          reservation.itemId,
          reservation.locationId,
          canonicalUom
        ]
      );

      await insertReservationEvent(client, tenantId, res.rows[0].id, 'RESERVED', reserveQty, 0);

      await enqueueInventoryReservationChanged(client, tenantId, res.rows[0].id, {
        itemId: reservation.itemId,
        locationId: reservation.locationId,
        demandId: reservation.demandId,
        demandType: reservation.demandType
      });
    }
    return rows;
  }, { isolationLevel: 'SERIALIZABLE', retries: 6 });
  atpCache.invalidate(cacheKey('atp', tenantId));
  return results.map(mapReservation);
}

export async function listReservations(tenantId: string, warehouseId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM inventory_reservations
     WHERE tenant_id = $1
       AND warehouse_id = $2
     ORDER BY reserved_at DESC
     LIMIT $3 OFFSET $4`,
    [tenantId, warehouseId, limit, offset],
  );
  return rows.map(mapReservation);
}

export async function getReservation(tenantId: string, id: string, warehouseId: string) {
  const res = await query(
    'SELECT * FROM inventory_reservations WHERE id = $1 AND tenant_id = $2 AND warehouse_id = $3',
    [id, tenantId, warehouseId]
  );
  if (res.rowCount === 0) return null;
  return mapReservation(res.rows[0]);
}

export async function allocateReservation(
  tenantId: string,
  id: string,
  warehouseId: string,
  options?: { idempotencyKey?: string | null }
) {
  const now = new Date();
  const result = await withTransactionRetry(async (client) => {
    const idempotencyKey = options?.idempotencyKey ?? null;
    if (idempotencyKey) {
      const record = await beginIdempotency(`reservation:${id}:allocate:${idempotencyKey}`, hashRequestBody({ id }), client);
      if (record.status === 'SUCCEEDED') {
        const res = await client.query(
          'SELECT * FROM inventory_reservations WHERE id = $1 AND tenant_id = $2 AND warehouse_id = $3',
          [
            id,
            tenantId,
            warehouseId
          ]
        );
        return res.rowCount ? mapReservation(res.rows[0]) : null;
      }
      if (record.status === 'IN_PROGRESS' && !record.isNew) {
        throw new Error('RESERVATION_ALLOCATE_IN_PROGRESS');
      }
    }

    const reservation = await lockReservationForUpdate(client, tenantId, id, warehouseId);
    if (reservation.status !== 'RESERVED') {
      throw reservationInvalidState();
    }

    const openQty = roundQuantity(
      Math.max(0, toNumber(reservation.quantity_reserved) - toNumber(reservation.quantity_fulfilled ?? 0))
    );
    if (openQty <= 1e-6) {
      throw reservationInvalidState();
    }

    const transition = await client.query(
      `UPDATE inventory_reservations
          SET status = 'ALLOCATED',
              allocated_at = COALESCE(allocated_at, $1),
              updated_at = $1
        WHERE id = $2
          AND tenant_id = $3
          AND warehouse_id = $4
          AND status = 'RESERVED'`,
      [now, id, tenantId, warehouseId]
    );
    if (transition.rowCount === 0) {
      throw reservationInvalidState();
    }

    if (openQty > 0) {
      await applyInventoryBalanceDelta(client, {
        tenantId,
        itemId: reservation.item_id,
        locationId: reservation.location_id,
        uom: reservation.uom,
        deltaReserved: -openQty,
        deltaAllocated: openQty
      });
    }

    if (openQty > 0) {
      await insertReservationEvent(client, tenantId, id, 'ALLOCATED', -openQty, openQty);
    }

    if (idempotencyKey) {
      await completeIdempotency(`reservation:${id}:allocate:${idempotencyKey}`, 'SUCCEEDED', `reservation:${id}`, client);
    }

    const updated = await client.query(
      `SELECT * FROM inventory_reservations
        WHERE id = $1
          AND tenant_id = $2
          AND warehouse_id = $3`,
      [id, tenantId, warehouseId]
    );
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
  warehouseId: string,
  params?: { reason?: string | null; idempotencyKey?: string | null }
) {
  const now = new Date();
  const allowAllocatedCancel = true;
  const result = await withTransactionRetry(async (client) => {
    const idempotencyKey = params?.idempotencyKey ?? null;
    if (idempotencyKey) {
      const record = await beginIdempotency(`reservation:${id}:cancel:${idempotencyKey}`, hashRequestBody({ id, reason: params?.reason ?? null }), client);
      if (record.status === 'SUCCEEDED') {
        const res = await client.query(
          'SELECT * FROM inventory_reservations WHERE id = $1 AND tenant_id = $2 AND warehouse_id = $3',
          [id, tenantId, warehouseId]
        );
        return res.rowCount ? mapReservation(res.rows[0]) : null;
      }
      if (record.status === 'IN_PROGRESS' && !record.isNew) {
        throw new Error('RESERVATION_CANCEL_IN_PROGRESS');
      }
    }

    const reservation = await lockReservationForUpdate(client, tenantId, id, warehouseId);
    const cancellableStatuses = allowAllocatedCancel ? ['RESERVED', 'ALLOCATED'] : ['RESERVED'];
    if (!cancellableStatuses.includes(reservation.status)) {
      throw reservationInvalidState();
    }

    const remaining = roundQuantity(
      Math.max(0, toNumber(reservation.quantity_reserved) - toNumber(reservation.quantity_fulfilled ?? 0))
    );
    const transition = await client.query(
      `UPDATE inventory_reservations
          SET status = 'CANCELLED',
              cancel_reason = $1,
              canceled_at = $2,
              updated_at = $2
        WHERE id = $3
          AND tenant_id = $4
          AND warehouse_id = $5
          AND status = ANY($6::text[])`,
      [params?.reason ?? null, now, id, tenantId, warehouseId, cancellableStatuses]
    );
    if (transition.rowCount === 0) {
      throw reservationInvalidState();
    }

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

    if (idempotencyKey) {
      await completeIdempotency(`reservation:${id}:cancel:${idempotencyKey}`, 'SUCCEEDED', `reservation:${id}`, client);
    }

    const updated = await client.query(
      `SELECT * FROM inventory_reservations
        WHERE id = $1
          AND tenant_id = $2
          AND warehouse_id = $3`,
      [id, tenantId, warehouseId]
    );
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
  warehouseId: string,
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
        const res = await client.query(
          'SELECT * FROM inventory_reservations WHERE id = $1 AND tenant_id = $2 AND warehouse_id = $3',
          [id, tenantId, warehouseId]
        );
        return res.rowCount ? mapReservation(res.rows[0]) : null;
      }
      if (record.status === 'IN_PROGRESS' && !record.isNew) {
        throw new Error('RESERVATION_FULFILL_IN_PROGRESS');
      }
    }

    const reservation = await lockReservationForUpdate(client, tenantId, id, warehouseId);
    if (reservation.status !== 'ALLOCATED') {
      throw reservationInvalidState();
    }

    const quantityReserved = toNumber(reservation.quantity_reserved);
    const quantityFulfilled = toNumber(reservation.quantity_fulfilled ?? 0);
    if (quantityFulfilled - quantityReserved > 1e-6) {
      throw reservationInvalidState();
    }
    const remaining = roundQuantity(
      Math.max(0, quantityReserved - quantityFulfilled)
    );
    if (remaining <= 1e-6) {
      throw reservationInvalidState();
    }
    // Fulfill is incremental: quantity is "consume now", never an absolute fulfilled total.
    const requestedInput = params?.quantity;
    if (typeof requestedInput !== 'number' || !Number.isFinite(requestedInput)) {
      throw reservationInvalidQuantity();
    }
    const requestedQty = roundQuantity(requestedInput);
    if (requestedQty <= 1e-6) {
      throw reservationInvalidQuantity();
    }
    const fulfillQty = roundQuantity(Math.max(0, Math.min(requestedQty, remaining)));
    const fulfilledTotal = roundQuantity(quantityFulfilled + fulfillQty);
    if (fulfilledTotal + 1e-6 < quantityFulfilled || fulfilledTotal - quantityReserved > 1e-6) {
      throw reservationInvalidState();
    }
    const newStatus = fulfilledTotal + 1e-6 >= quantityReserved ? 'FULFILLED' : 'ALLOCATED';

    const transition = await client.query(
      `UPDATE inventory_reservations
          SET quantity_fulfilled = $1,
              status = $2,
              fulfilled_at = CASE WHEN $2 = 'FULFILLED' THEN COALESCE(fulfilled_at, $3) ELSE fulfilled_at END,
              updated_at = $3
        WHERE id = $4
          AND tenant_id = $5
          AND warehouse_id = $6
          AND status = 'ALLOCATED'`,
      [fulfilledTotal, newStatus, now, id, tenantId, warehouseId]
    );
    if (transition.rowCount === 0) {
      throw reservationInvalidState();
    }

    if (fulfillQty > 0) {
      await applyInventoryBalanceDelta(client, {
        tenantId,
        itemId: reservation.item_id,
        locationId: reservation.location_id,
        uom: reservation.uom,
        deltaAllocated: -fulfillQty
      });
    }

    if (fulfillQty > 0) {
      await insertReservationEvent(client, tenantId, id, 'FULFILLED', 0, -fulfillQty);
    }

    if (idempotencyKey) {
      await completeIdempotency(`reservation:${id}:fulfill:${idempotencyKey}`, 'SUCCEEDED', `reservation:${id}`, client);
    }

    const updated = await client.query(
      `SELECT * FROM inventory_reservations
        WHERE id = $1
          AND tenant_id = $2
          AND warehouse_id = $3`,
      [id, tenantId, warehouseId]
    );
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
    // Lock order invariant: reservation rows -> inventory_balance rows.
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
      const transition = await client.query(
        `UPDATE inventory_reservations
            SET status = 'EXPIRED',
                expired_at = $1,
                updated_at = $1
          WHERE id = $2
            AND tenant_id = $3
            AND status = 'RESERVED'`,
        [now, row.id, row.tenant_id]
      );
      if (transition.rowCount === 0) {
        continue;
      }
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

    const shipFromWarehouseId = await resolveWarehouseIdForLocation(tenantId, shipment.ship_from_location_id, client);
    type ShipmentLineContext = {
      line: any;
      canonicalOut: Awaited<ReturnType<typeof getCanonicalMovementFields>>;
      issueQty: number;
      reservationId: string | null;
      reservation: ReservationRow | null;
      reserveConsume: number;
    };
    const shipmentLineContexts: ShipmentLineContext[] = [];
    const reservationIdsToLock = new Set<string>();
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
      const reservationIdRes = await client.query<{ id: string }>(
        `SELECT id
           FROM inventory_reservations
          WHERE tenant_id = $1
            AND warehouse_id = $2
            AND demand_type = 'sales_order_line'
            AND demand_id = $3
            AND item_id = $4
            AND location_id = $5
            AND uom = $6
            AND status IN ('RESERVED', 'ALLOCATED')
          LIMIT 1`,
        [
          tenantId,
          shipFromWarehouseId,
          line.sales_order_line_id,
          line.item_id,
          shipment.ship_from_location_id,
          canonicalOut.canonicalUom
        ]
      );
      const reservationId = reservationIdRes.rows[0]?.id ?? null;
      if (reservationId) {
        reservationIdsToLock.add(reservationId);
      }
      shipmentLineContexts.push({
        line,
        canonicalOut,
        issueQty,
        reservationId,
        reservation: null,
        reserveConsume: 0
      });
    }

    const lockedReservations = await lockReservationsForUpdate(
      client,
      tenantId,
      shipFromWarehouseId,
      Array.from(reservationIdsToLock)
    );
    const lockedReservationsById = new Map(lockedReservations.map((row) => [row.id, row]));

    const stockValidationLines: {
      itemId: string;
      locationId: string;
      uom: string;
      quantityToConsume: number;
    }[] = [];
    for (const lineContext of shipmentLineContexts) {
      const reservation = lineContext.reservationId
        ? lockedReservationsById.get(lineContext.reservationId) ?? null
        : null;
      if (lineContext.reservationId && !reservation) {
        throw reservationInvalidState();
      }
      const reservedRemaining = reservation
        && (reservation.status === 'RESERVED' || reservation.status === 'ALLOCATED')
        ? roundQuantity(Math.max(0, toNumber(reservation.quantity_reserved) - toNumber(reservation.quantity_fulfilled ?? 0)))
        : 0;
      const reserveConsume = Math.min(lineContext.issueQty, reservedRemaining);
      lineContext.reservation = reservation;
      lineContext.reserveConsume = reserveConsume;
      stockValidationLines.push({
        itemId: lineContext.line.item_id,
        locationId: shipment.ship_from_location_id,
        uom: lineContext.canonicalOut.canonicalUom,
        quantityToConsume: roundQuantity(Math.max(0, lineContext.issueQty - reserveConsume))
      });
    }
    stockValidationLines.sort((a, b) => {
      const item = a.itemId.localeCompare(b.itemId);
      if (item !== 0) return item;
      const location = a.locationId.localeCompare(b.locationId);
      if (location !== 0) return location;
      return a.uom.localeCompare(b.uom);
    });

    let validation: StockValidationResult;
    try {
      validation = await validateSufficientStock(
        tenantId,
        now,
        stockValidationLines,
        {
          actorId: params.actor?.id ?? null,
          actorRole: params.actor?.role ?? null,
          overrideRequested: params.overrideRequested,
          overrideReason: params.overrideReason ?? null,
          overrideReference: `shipment:${shipmentId}`
        },
        { client }
      );
    } catch (error: any) {
      if (error?.code === 'INSUFFICIENT_STOCK' || error?.message === 'INSUFFICIENT_STOCK') {
        throw insufficientAvailableWithAllowance({
          shipmentId,
          details: error?.details
        });
      }
      throw error;
    }

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

    for (const lineContext of shipmentLineContexts) {
      const { line, canonicalOut, issueQty, reservation, reserveConsume } = lineContext;

      await getInventoryBalanceForUpdate(
        client,
        tenantId,
        line.item_id,
        shipment.ship_from_location_id,
        canonicalOut.canonicalUom
      );
      const canonicalAvailability = await getCanonicalAvailability(
        client,
        tenantId,
        shipFromWarehouseId,
        line.item_id,
        shipment.ship_from_location_id,
        canonicalOut.canonicalUom
      );
      const shipmentAvailable = roundQuantity(canonicalAvailability.available);
      if (!canShipWithReservationAllowance(shipmentAvailable, reserveConsume, issueQty) && !validation.overrideMetadata) {
        throw insufficientAvailableWithAllowance({
          shipmentId,
          shipmentLineId: line.id,
          itemId: line.item_id,
          available: shipmentAvailable,
          reserveConsume,
          shipQty: issueQty
        });
      }

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
        const allocateTransition = await client.query(
          `UPDATE inventory_reservations
              SET status = 'ALLOCATED',
                  allocated_at = COALESCE(allocated_at, $1),
                  updated_at = $1
            WHERE id = $2
              AND tenant_id = $3
              AND warehouse_id = $4
              AND status = 'RESERVED'`,
          [now, reservation.id, tenantId, shipFromWarehouseId]
        );
        if (allocateTransition.rowCount === 0) {
          throw reservationInvalidState();
        }

        await applyInventoryBalanceDelta(client, {
          tenantId,
          itemId: line.item_id,
          locationId: shipment.ship_from_location_id,
          uom: canonicalOut.canonicalUom,
          deltaReserved: -reserveConsume,
          deltaAllocated: reserveConsume
        });
        await insertReservationEvent(client, tenantId, reservation.id, 'ALLOCATED', -reserveConsume, reserveConsume);
        reservation.status = 'ALLOCATED';
      }

      await applyInventoryBalanceDelta(client, {
        tenantId,
        itemId: line.item_id,
        locationId: shipment.ship_from_location_id,
        uom: canonicalOut.canonicalUom,
        deltaOnHand: -issueQty,
        deltaAllocated: -reserveConsume
      });

      if (reservation && reserveConsume > 0) {
        if (reservation.status !== 'ALLOCATED') {
          throw reservationInvalidState();
        }
        const fulfilled = roundQuantity(
          Math.min(
            toNumber(reservation.quantity_reserved),
            toNumber(reservation.quantity_fulfilled ?? 0) + reserveConsume
          )
        );
        const newStatus = fulfilled + 1e-6 >= toNumber(reservation.quantity_reserved) ? 'FULFILLED' : 'ALLOCATED';
        const fulfillTransition = await client.query(
          `UPDATE inventory_reservations
              SET quantity_fulfilled = $1,
                  status = $2,
                  updated_at = $3,
                  fulfilled_at = CASE WHEN $2 = 'FULFILLED' THEN COALESCE(fulfilled_at, $3) ELSE fulfilled_at END
            WHERE id = $4
              AND tenant_id = $5
              AND warehouse_id = $6
              AND status = 'ALLOCATED'`,
          [fulfilled, newStatus, now, reservation.id, tenantId, shipFromWarehouseId]
        );
        if (fulfillTransition.rowCount === 0) {
          throw reservationInvalidState();
        }

        await insertReservationEvent(
          client,
          tenantId,
          reservation.id,
          newStatus === 'FULFILLED' ? 'FULFILLED' : 'ALLOCATED',
          0,
          -reserveConsume
        );
        reservation.quantity_fulfilled = fulfilled;
        reservation.status = newStatus;

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
