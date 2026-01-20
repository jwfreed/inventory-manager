import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import {
  reservationsCreateSchema,
  reservationSchema,
  returnAuthorizationSchema,
  salesOrderSchema,
  shipmentSchema,
} from '../schemas/orderToCash.schema';
import { convertToCanonical } from './uomCanonical.service';
import { getItem } from './masterData.service';
import { getInventorySnapshot } from './inventorySnapshot.service';
import { upsertBackorder } from './backorders.service';
import { roundQuantity, toNumber } from '../lib/numbers';
import { ItemLifecycleStatus } from '../types/item';

export type SalesOrderInput = z.infer<typeof salesOrderSchema>;
export type ReservationInput = z.infer<typeof reservationSchema>;
export type ReservationCreateInput = z.infer<typeof reservationsCreateSchema>;
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
    demandType: row.demand_type,
    demandId: row.demand_id,
    itemId: row.item_id,
    locationId: row.location_id,
    uom: row.uom,
    quantityReserved: row.quantity_reserved,
    quantityFulfilled: row.quantity_fulfilled,
    reservedAt: row.reserved_at,
    releasedAt: row.released_at,
    releaseReasonCode: row.release_reason_code,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createReservations(tenantId: string, data: ReservationCreateInput) {
  const now = new Date();
  const results: any[] = [];
  await withTransaction(async (client) => {
    for (const reservation of data.reservations) {
      const canonical = await convertToCanonical(
        tenantId,
        reservation.itemId,
        reservation.quantityReserved,
        reservation.uom,
        client
      );
      const snapshot = await getInventorySnapshot(tenantId, {
        itemId: reservation.itemId,
        locationId: reservation.locationId,
        uom: canonical.canonicalUom
      });
      const available = toNumber(snapshot.find((row) => row.uom === canonical.canonicalUom)?.available ?? 0);
      const reserveQty = roundQuantity(Math.max(0, Math.min(canonical.quantity, available)));
      const backorderQty = roundQuantity(Math.max(0, canonical.quantity - reserveQty));

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
        reservation.quantityFulfilled != null ? Math.min(reservation.quantityFulfilled, reserveQty) : null;
      const res = await client.query(
        `INSERT INTO inventory_reservations (
          id, tenant_id, status, demand_type, demand_id, item_id, location_id, uom,
          quantity_reserved, quantity_fulfilled, reserved_at, notes, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
        RETURNING *`,
        [
          uuidv4(),
          tenantId,
          reservation.status ?? 'open',
          reservation.demandType,
          reservation.demandId,
          reservation.itemId,
          reservation.locationId,
          canonical.canonicalUom,
          reserveQty,
          fulfilledQty,
          reservation.status === 'open' ? now : now,
          reservation.notes ?? null,
          now,
        ],
      );
      results.push(res.rows[0]);
    }
  });
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

export function mapShipment(row: any, lines: any[]) {
  return {
    id: row.id,
    salesOrderId: row.sales_order_id,
    shippedAt: row.shipped_at,
    shipFromLocationId: row.ship_from_location_id,
    inventoryMovementId: row.inventory_movement_id,
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

export async function getShipment(tenantId: string, id: string) {
  const shipment = await query('SELECT * FROM sales_order_shipments WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
  ]);
  if (shipment.rowCount === 0) return null;
  const lines = await query(
    'SELECT * FROM sales_order_shipment_lines WHERE sales_order_shipment_id = $1 AND tenant_id = $2 ORDER BY created_at ASC',
    [id, tenantId],
  );
  return mapShipment(shipment.rows[0], lines.rows);
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
