import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
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
  ensureInventoryBalanceRowAndLock
} from '../domains/inventory';
import { resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import { getSellableSupplyMap } from './atp.service';
import {
  hashTransactionalIdempotencyRequest
} from '../lib/transactionalIdempotency';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import {
  runInventoryCommand,
  type InventoryCommandEvent,
  type InventoryCommandProjectionOp
} from '../modules/platform/application/runInventoryCommand';
import { buildInventoryRegistryEvent } from '../modules/platform/application/inventoryEventRegistry';
import {
  buildPostedDocumentReplayResult,
  buildInventoryBalanceProjectionOp,
  buildReplayCorruptionError,
  buildMovementPostedEvent,
  buildRefreshItemCostSummaryProjectionOp
} from '../modules/platform/application/inventoryMutationSupport';
import { upsertBackorder } from './backorders.service';
import { roundQuantity, toNumber } from '../lib/numbers';
import { ItemLifecycleStatus } from '../types/item';
import { validateSufficientStock, type StockValidationResult } from './stockValidation.service';
import {
  persistInventoryMovement
} from '../domains/inventory';
import { assertItemSellableInvariant } from './manufacturingInvariant.service';
import {
  applyPlannedCostLayerConsumption,
  planCostLayerConsumption
} from './costLayers.service';
import { recordAuditLog } from '../lib/audit';
import { invalidateAtpCacheForWarehouse } from './atpCache.service';
import { assertSellableLocationOrThrow } from '../domains/inventory';
import {
  assertAtpLockHeldOrThrow,
  buildAtpLockKeys,
  type AtpLockContext,
  type AtpLockTarget
} from '../domains/inventory/internal/atpLocks';
import { resolveAtpRetryBudgets } from '../config/atpRetryBudgets';

export type SalesOrderInput = z.infer<typeof salesOrderSchema>;
export type ReservationInput = z.infer<typeof reservationSchema>;
export type ReservationCreateInput = z.infer<typeof reservationsCreateSchema>;
export type PostShipmentInternalHooks = {
  onLoaded?: (context: {
    client: PoolClient;
    shipment: any;
    shipmentLines: any[];
    shipmentAlreadyPosted: boolean;
  }) => Promise<void>;
  afterPost?: (context: {
    client: PoolClient;
    shipment: any;
    shipmentLines: any[];
    movementId: string;
    occurredAt: Date;
    idempotencyKey: string;
  }) => Promise<void>;
};
type ReservationCreateLine = ReservationCreateInput['reservations'][number];
type PreparedReservationCreateLine = {
  reservation: ReservationCreateLine;
  derivedWarehouseId: string;
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
const atpRetryBudgets = resolveAtpRetryBudgets();
const ATP_SERIALIZABLE_RETRIES = atpRetryBudgets.serializableRetries;
const ATP_RESERVATION_CREATE_RETRIES = Math.max(atpRetryBudgets.reservationCreateRetries, 10);
// Shipment posting is the heaviest ATP mutation path (reservation transitions + FIFO issue);
// allow a slightly larger retry window than the baseline serializable budget.
const ATP_SHIPMENT_POST_RETRIES = Math.max(ATP_SERIALIZABLE_RETRIES, 8);
const ATP_RETRY_BASE_DELAY_MS = 5;
const ATP_RETRY_JITTER_MS = 5;

let atpRetryRandom = () => Math.random();
let atpRetrySleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));
let atpMetricsSink: ((event: string, payload: Record<string, unknown>) => void) | null = null;

type StructuredServiceError = Error & {
  code?: string;
  status?: number;
  details?: Record<string, unknown>;
};

type AtpErrorContext = {
  operation: 'reserve' | 'allocate' | 'cancel' | 'fulfill' | 'shipment_post' | 'shipment_create_allocate' | 'expire';
  tenantId: string;
  warehouseIds?: string[];
  itemIds?: string[];
  lockKeysCount?: number;
};

function compareReservationLockKey(
  left: PreparedReservationCreateLine,
  right: PreparedReservationCreateLine
): number {
  const warehouseCompare = left.derivedWarehouseId.localeCompare(right.derivedWarehouseId);
  if (warehouseCompare !== 0) return warehouseCompare;
  const itemCompare = left.reservation.itemId.localeCompare(right.reservation.itemId);
  if (itemCompare !== 0) return itemCompare;
  const locationCompare = left.reservation.locationId.localeCompare(right.reservation.locationId);
  if (locationCompare !== 0) return locationCompare;
  const leftUom = String(left.reservation.uom ?? '').trim().toLowerCase();
  const rightUom = String(right.reservation.uom ?? '').trim().toLowerCase();
  const uomCompare = leftUom.localeCompare(rightUom);
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

function mapUniqueValues(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value.length > 0)
    )
  ).sort((left, right) => left.localeCompare(right));
}

function emitAtpMetric(event: string, payload: Record<string, unknown>) {
  atpMetricsSink?.(event, payload);
}

export function __setAtpRetryHooksForTests(
  hooks?: Partial<{ random: () => number; sleep: (delayMs: number) => Promise<void> }>
) {
  atpRetryRandom = hooks?.random ?? (() => Math.random());
  atpRetrySleep = hooks?.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
}

export function __setAtpMetricsSinkForTests(
  sink?: ((event: string, payload: Record<string, unknown>) => void) | null
) {
  atpMetricsSink = sink ?? null;
}

export type AtpRetryContextForTests = AtpErrorContext;

export function __buildAtpRetryOptionsForTests(context: AtpErrorContext, retries: number) {
  return buildAtpRetryOptions(context, retries);
}

export function __mapAtpRetryErrorForTests(error: unknown, context: AtpErrorContext) {
  try {
    withAtpRetryHandling(error, context);
  } catch (mappedError) {
    return mappedError as StructuredServiceError;
  }
  throw new Error('ATP_RETRY_ERROR_EXPECTED_TO_THROW');
}

function computeAtpRetryDelayMs(attempt: number): number {
  const normalizedAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  const rawRandom = Number(atpRetryRandom());
  const normalizedRandom = Number.isFinite(rawRandom)
    ? Math.min(0.999999, Math.max(0, rawRandom))
    : 0;
  const jitterMs = Math.floor(normalizedRandom * (ATP_RETRY_JITTER_MS + 1));
  return ATP_RETRY_BASE_DELAY_MS * normalizedAttempt + jitterMs;
}

function buildAtpRetryOptions(context: AtpErrorContext, retries: number) {
  return {
    isolationLevel: 'SERIALIZABLE' as const,
    retries,
    retryDelayMs: ({ attempt }: { attempt: number; sqlState: string }) => computeAtpRetryDelayMs(attempt),
    onRetry: ({ attempt, sqlState, delayMs }: { attempt: number; sqlState: string; delayMs: number }) => {
      emitAtpMetric('atp_tx_retry_attempts', {
        operation: context.operation,
        tenantId: context.tenantId,
        warehouseIds: mapUniqueValues(context.warehouseIds ?? []),
        itemIds: mapUniqueValues(context.itemIds ?? []),
        attempt,
        sqlState,
        delayMs
      });
    },
    sleep: atpRetrySleep
  };
}

function atpInsufficientAvailable(details: Record<string, unknown>): StructuredServiceError {
  const error = new Error('ATP_INSUFFICIENT_AVAILABLE') as StructuredServiceError;
  error.code = 'ATP_INSUFFICIENT_AVAILABLE';
  error.status = 409;
  error.details = details;
  emitAtpMetric('atp_insufficient_available_count', {
    count: 1,
    ...details
  });
  return error;
}

function atpConcurrencyExhausted(
  details: Record<string, unknown>,
  cause?: unknown
): StructuredServiceError {
  const error = new Error('ATP_CONCURRENCY_EXHAUSTED') as StructuredServiceError & { cause?: unknown };
  error.code = 'ATP_CONCURRENCY_EXHAUSTED';
  error.status = 409;
  error.details = details;
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function withAtpRetryHandling(error: any, context: AtpErrorContext): never {
  if (error?.code === 'TX_RETRY_EXHAUSTED') {
    const attempts = Number(error?.retryAttempts ?? ATP_SERIALIZABLE_RETRIES + 1);
    const retrySqlState = typeof error?.retrySqlState === 'string' ? error.retrySqlState : null;
    const warehouseIds = mapUniqueValues(context.warehouseIds ?? []);
    const itemIds = mapUniqueValues(context.itemIds ?? []);
    const lockKeysCount = Number.isFinite(context.lockKeysCount)
      ? Math.max(0, Number(context.lockKeysCount))
      : buildAtpLockKeys(
        itemIds.flatMap((itemId) =>
          warehouseIds.map((warehouseId) => ({ tenantId: context.tenantId, warehouseId, itemId }))
        )
      ).length;
    const details = {
      operation: context.operation,
      tenantId: context.tenantId,
      warehouseIds,
      itemIds,
      warehouseId: warehouseIds.length === 1 ? warehouseIds[0] : null,
      itemId: itemIds.length === 1 ? itemIds[0] : null,
      lockKeysCount,
      reason: 'tx_retry_exhausted',
      attempts,
      retryable: true,
      atp_retry_count: Math.max(0, attempts - 1),
      retrySqlState
    };
    emitAtpMetric('atp_retry_count', {
      operation: context.operation,
      tenantId: context.tenantId,
      warehouseIds,
      itemIds,
      attempts,
      atp_retry_count: Math.max(0, attempts - 1),
      retrySqlState
    });
    emitAtpMetric('atp_concurrency_exhausted_count', {
      count: 1,
      ...details
    });
    throw atpConcurrencyExhausted(details, error);
  }
  throw error;
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
  client: PoolClient,
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
  const versionResult = await client.query<{ event_version: string | number }>(
    `SELECT COUNT(*)::int AS event_version
       FROM reservation_events
      WHERE tenant_id = $1
        AND reservation_id = $2`,
    [tenantId, reservationId]
  );
  return Number(versionResult.rows[0]?.event_version ?? 1);
}

function buildReservationChangedEvent(
  reservation: any,
  eventVersion: number,
  producerIdempotencyKey?: string | null
): InventoryCommandEvent {
  return buildInventoryRegistryEvent('inventoryReservationChanged', {
    eventVersion,
    producerIdempotencyKey: producerIdempotencyKey ?? null,
    payload: {
      reservationId: reservation.id,
      itemId: reservation.item_id,
      locationId: reservation.location_id,
      demandId: reservation.demand_id,
      demandType: reservation.demand_type,
      status: reservation.status
    },
    dispatch: {
      aggregateType: 'inventory_reservation_change',
      aggregateId: uuidv4()
    }
  });
}

function compareReservationMutationScope(left: ReservationRow, right: ReservationRow): number {
  const tenantCompare = left.tenant_id.localeCompare(right.tenant_id);
  if (tenantCompare !== 0) return tenantCompare;
  const warehouseCompare = String(left.warehouse_id ?? '').localeCompare(String(right.warehouse_id ?? ''));
  if (warehouseCompare !== 0) return warehouseCompare;
  const itemCompare = left.item_id.localeCompare(right.item_id);
  if (itemCompare !== 0) return itemCompare;
  const locationCompare = left.location_id.localeCompare(right.location_id);
  if (locationCompare !== 0) return locationCompare;
  const uomCompare = left.uom.localeCompare(right.uom);
  if (uomCompare !== 0) return uomCompare;
  return left.id.localeCompare(right.id);
}

async function resolveReservationDerivedWarehouseScope(
  client: PoolClient,
  tenantId: string,
  reservation: ReservationCreateLine
) {
  let salesOrderWarehouseId: string | null = null;
  const res = await client.query<{ warehouse_id: string | null }>(
    `SELECT so.warehouse_id
       FROM sales_order_lines sol
       JOIN sales_orders so
         ON so.id = sol.sales_order_id
        AND so.tenant_id = sol.tenant_id
      WHERE sol.tenant_id = $1
        AND sol.id = $2
      LIMIT 1`,
    [tenantId, reservation.demandId]
  );
  if ((res.rowCount ?? 0) > 0) {
    salesOrderWarehouseId = res.rows[0]?.warehouse_id ?? null;
    if (!salesOrderWarehouseId) {
      throw new Error('WAREHOUSE_SCOPE_REQUIRED');
    }
  }

  const locationWarehouseId = await resolveWarehouseIdForLocation(tenantId, reservation.locationId, client);
  if (!locationWarehouseId) {
    throw new Error('WAREHOUSE_SCOPE_REQUIRED');
  }

  const derivedWarehouseId = salesOrderWarehouseId ?? locationWarehouseId;
  if (salesOrderWarehouseId && salesOrderWarehouseId !== locationWarehouseId) {
    throw new Error('WAREHOUSE_SCOPE_MISMATCH');
  }
  if (reservation.warehouseId && reservation.warehouseId !== derivedWarehouseId) {
    throw new Error('WAREHOUSE_SCOPE_MISMATCH');
  }

  return derivedWarehouseId;
}

async function getCanonicalAvailability(
  client: PoolClient,
  tenantId: string,
  warehouseId: string,
  itemId: string,
  locationId: string,
  uom: string,
  lockContext: AtpLockContext
) {
  assertAtpLockHeldOrThrow(lockContext, {
    operation: lockContext.operation,
    tenantId,
    warehouseId,
    itemId,
    locationId,
    uom
  });
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
type PreparedShipmentLineInput = ShipmentInput['lines'][number] & { id: string };
type ShipmentSalesOrderLineRow = { id: string; item_id: string };
type ShipmentWarehouseScope = {
  salesOrderWarehouseId: string | null;
  shipFromWarehouseId: string | null;
};

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
    warehouseId: row.warehouse_id ?? null,
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
  const warehouseId = orderRow.warehouse_id
    ? orderRow.warehouse_id
    : locationId
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
  if (!data.warehouseId) {
    throw new Error('WAREHOUSE_SCOPE_REQUIRED');
  }

  const result = await withTransaction(async (client) => {
    if (data.shipFromLocationId) {
      const resolvedWarehouseId = await resolveWarehouseIdForLocation(tenantId, data.shipFromLocationId, client);
      if (!resolvedWarehouseId || resolvedWarehouseId !== data.warehouseId) {
        throw new Error('WAREHOUSE_SCOPE_MISMATCH');
      }
    }

    const orderResult = await client.query(
      `INSERT INTO sales_orders (
        id, tenant_id, so_number, customer_id, status, order_date, requested_ship_date,
        ship_from_location_id, warehouse_id, customer_reference, notes, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
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
        data.warehouseId,
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
      await assertItemSellableInvariant(tenantId, line.itemId);

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
  filters: { status?: string; customerId?: string; warehouseId?: string }
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
  if (filters.warehouseId) {
    params.push(filters.warehouseId);
    conditions.push(`warehouse_id = $${params.length}`);
  }
  params.push(limit, offset);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT id, so_number, customer_id, status, order_date, requested_ship_date, ship_from_location_id, warehouse_id,
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
  const transactionalIdempotencyKey = typeof baseIdempotency === 'string' && baseIdempotency.trim()
    ? baseIdempotency.trim()
    : null;
  const reservationRequestHash = transactionalIdempotencyKey
    ? hashTransactionalIdempotencyRequest({
      method: 'POST',
      endpoint: IDEMPOTENCY_ENDPOINTS.RESERVATIONS_CREATE,
      body: {
        reservations: [...data.reservations]
          .map((reservation) => ({
            demandType: reservation.demandType,
            demandId: reservation.demandId,
            itemId: reservation.itemId,
            warehouseId: reservation.warehouseId,
            locationId: reservation.locationId,
            uom: reservation.uom,
            quantityReserved: roundQuantity(toNumber(reservation.quantityReserved)),
            quantityFulfilled: reservation.quantityFulfilled ?? null,
            expiresAt: reservation.expiresAt ?? null,
            notes: reservation.notes ?? null,
            allowBackorder: reservation.allowBackorder ?? null
          }))
          .sort((left, right) => {
            const demandType = left.demandType.localeCompare(right.demandType);
            if (demandType !== 0) return demandType;
            const demandId = left.demandId.localeCompare(right.demandId);
            if (demandId !== 0) return demandId;
            const item = left.itemId.localeCompare(right.itemId);
            if (item !== 0) return item;
            const warehouse = (left.warehouseId ?? '').localeCompare(right.warehouseId ?? '');
            if (warehouse !== 0) return warehouse;
            const location = left.locationId.localeCompare(right.locationId);
            if (location !== 0) return location;
            const uom = left.uom.localeCompare(right.uom);
            if (uom !== 0) return uom;
            return left.quantityReserved - right.quantityReserved;
          })
      }
    })
    : null;
  let reserveRetryContext: AtpErrorContext = {
    operation: 'reserve',
    tenantId,
    warehouseIds: mapUniqueValues(data.reservations.map((reservation) => reservation.warehouseId)),
    itemIds: mapUniqueValues(data.reservations.map((reservation) => reservation.itemId)),
    lockKeysCount: 0
  };
  let results: any[];
  try {
    let preparedLines: PreparedReservationCreateLine[] = [];
    results = await runInventoryCommand<any[]>({
      tenantId,
      endpoint: IDEMPOTENCY_ENDPOINTS.RESERVATIONS_CREATE,
      operation: 'reserve',
      idempotencyKey: transactionalIdempotencyKey,
      requestHash: reservationRequestHash,
      retryOptions: buildAtpRetryOptions(reserveRetryContext, ATP_RESERVATION_CREATE_RETRIES),
      lockTargets: async (client) => {
        preparedLines = [];
        for (const reservation of data.reservations) {
          const derivedWarehouseId = await resolveReservationDerivedWarehouseScope(client, tenantId, reservation);
          preparedLines.push({
            reservation,
            derivedWarehouseId
          });
        }
        preparedLines.sort(compareReservationLockKey);
        const advisoryTargets: AtpLockTarget[] = preparedLines.map((line) => ({
          tenantId,
          warehouseId: line.derivedWarehouseId,
          itemId: line.reservation.itemId
        }));
        reserveRetryContext = {
          operation: 'reserve',
          tenantId,
          warehouseIds: mapUniqueValues(preparedLines.map((line) => line.derivedWarehouseId)),
          itemIds: mapUniqueValues(preparedLines.map((line) => line.reservation.itemId)),
          lockKeysCount: buildAtpLockKeys(advisoryTargets).length
        };
        return advisoryTargets;
      },
      execute: async ({ client, lockContext }) => {
        const rows: any[] = [];
        const events: InventoryCommandEvent[] = [];
        const projectionOps: Array<(projectionClient: PoolClient) => Promise<void>> = [];

        for (const line of preparedLines) {
          const { reservation, derivedWarehouseId } = line;
          const canonical = await convertToCanonical(
            tenantId,
            reservation.itemId,
            reservation.quantityReserved,
            reservation.uom,
            client
          );
          const canonicalQuantity = roundQuantity(canonical.quantity);
          const canonicalUom = canonical.canonicalUom;
          await assertSellableLocationOrThrow(client, tenantId, reservation.locationId, {
            expectedWarehouseId: derivedWarehouseId
          });
          const idempotencyKey = baseIdempotency
            ? `${baseIdempotency}:${reservation.demandId}:${reservation.itemId}:${reservation.locationId}:${derivedWarehouseId}:${canonicalUom}`
            : null;
          if (idempotencyKey) {
            const existing = await client.query(
              `SELECT * FROM inventory_reservations
                WHERE client_id = $1 AND idempotency_key = $2`,
              [tenantId, idempotencyKey]
            );
            if ((existing.rowCount ?? 0) > 0) {
              rows.push(existing.rows[0]);
              continue;
            }
          }
          const warehouseId = derivedWarehouseId;

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
              canonicalUom,
              lockContext
            );
            const available = roundQuantity(availability.available);
            reserveQty = roundQuantity(Math.max(0, Math.min(canonicalQuantity, available)));
            backorderQty = roundQuantity(Math.max(0, canonicalQuantity - reserveQty));
          }
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
              canonicalUom,
              lockContext
            );
            const available = roundQuantity(availability.available);
            if (available + 1e-6 < reserveQty) {
              throw atpInsufficientAvailable({
                operation: 'reserve',
                tenantId,
                warehouseId,
                itemId: reservation.itemId,
                locationId: reservation.locationId,
                uom: canonicalUom,
                available,
                requested: reserveQty
              });
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
              if ((existing.rowCount ?? 0) > 0) {
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
            if ((existing.rowCount ?? 0) > 0) {
              rows.push(existing.rows[0]);
              continue;
            }
            throw new Error('RESERVATION_CONFLICT');
          }
          rows.push(res.rows[0]);
          const eventVersion = await insertReservationEvent(client, tenantId, res.rows[0].id, 'RESERVED', reserveQty, 0);
          events.push(buildReservationChangedEvent(res.rows[0], eventVersion, transactionalIdempotencyKey));
          projectionOps.push(async (projectionClient) => {
            await applyInventoryBalanceDelta(projectionClient, {
              tenantId,
              itemId: reservation.itemId,
              locationId: reservation.locationId,
              uom: canonicalUom,
              deltaReserved: reserveQty
            });
          });
        }

        return {
          responseStatus: 201,
          responseBody: rows,
          events,
          projectionOps
        };
      }
    });
  } catch (error) {
    withAtpRetryHandling(error, reserveRetryContext);
  }
  const affectedWarehouses = new Set<string>();
  for (const row of results) {
    if (typeof row?.warehouse_id === 'string') {
      affectedWarehouses.add(row.warehouse_id);
    }
  }
  for (const warehouseId of affectedWarehouses) {
    invalidateAtpCacheForWarehouse(tenantId, warehouseId);
  }
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
  const transactionalIdempotencyKey =
    typeof options?.idempotencyKey === 'string' && options.idempotencyKey.trim()
      ? options.idempotencyKey.trim()
      : null;
  const requestHash = transactionalIdempotencyKey
    ? hashTransactionalIdempotencyRequest({
        method: 'POST',
        endpoint: IDEMPOTENCY_ENDPOINTS.RESERVATIONS_ALLOCATE,
        body: {
          reservationId: id,
          warehouseId
        }
      })
    : null;
  let allocateRetryContext: AtpErrorContext = {
    operation: 'allocate',
    tenantId,
    warehouseIds: [warehouseId],
    itemIds: [],
    lockKeysCount: 0
  };
  let lockedReservation: ReservationRow | null = null;
  let result: any;
  try {
    result = await runInventoryCommand<any | null>({
      tenantId,
      endpoint: IDEMPOTENCY_ENDPOINTS.RESERVATIONS_ALLOCATE,
      operation: 'allocate',
      idempotencyKey: transactionalIdempotencyKey,
      requestHash,
      retryOptions: buildAtpRetryOptions(allocateRetryContext, ATP_SERIALIZABLE_RETRIES),
      lockTargets: async (client) => {
        lockedReservation = await lockReservationForUpdate(client, tenantId, id, warehouseId);
        const advisoryTargets: AtpLockTarget[] = [{
          tenantId,
          warehouseId: lockedReservation.warehouse_id,
          itemId: lockedReservation.item_id
        }];
        allocateRetryContext = {
          operation: 'allocate',
          tenantId,
          warehouseIds: [lockedReservation.warehouse_id],
          itemIds: [lockedReservation.item_id],
          lockKeysCount: buildAtpLockKeys(advisoryTargets).length
        };
        return advisoryTargets;
      },
      execute: async ({ client }) => {
        const reservation = lockedReservation;
        if (!reservation) {
          throw new Error('RESERVATION_NOT_FOUND');
        }

        await assertSellableLocationOrThrow(client, tenantId, reservation.location_id, {
          expectedWarehouseId: reservation.warehouse_id
        });
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

        const eventVersion = await insertReservationEvent(client, tenantId, id, 'ALLOCATED', -openQty, openQty);
        const updated = await client.query(
          `SELECT * FROM inventory_reservations
            WHERE id = $1
              AND tenant_id = $2
              AND warehouse_id = $3`,
          [id, tenantId, warehouseId]
        );

        return {
          responseBody: (updated.rowCount ?? 0) > 0 ? mapReservation(updated.rows[0]) : null,
          events: (updated.rowCount ?? 0) > 0
            ? [buildReservationChangedEvent(updated.rows[0], eventVersion, transactionalIdempotencyKey)]
            : [],
          projectionOps: [
            async (projectionClient: PoolClient) => {
              await applyInventoryBalanceDelta(projectionClient, {
                tenantId,
                itemId: reservation.item_id,
                locationId: reservation.location_id,
                uom: reservation.uom,
                deltaReserved: -openQty,
                deltaAllocated: openQty
              });
            }
          ]
        };
      }
    });
  } catch (error: any) {
    if (error?.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
      throw new Error('RESERVATION_ALLOCATE_IN_PROGRESS');
    }
    withAtpRetryHandling(error, allocateRetryContext);
  }
  invalidateAtpCacheForWarehouse(tenantId, warehouseId);
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
  const transactionalIdempotencyKey =
    typeof params?.idempotencyKey === 'string' && params.idempotencyKey.trim()
      ? params.idempotencyKey.trim()
      : null;
  const requestHash = transactionalIdempotencyKey
    ? hashTransactionalIdempotencyRequest({
        method: 'POST',
        endpoint: IDEMPOTENCY_ENDPOINTS.RESERVATIONS_CANCEL,
        body: {
          reservationId: id,
          warehouseId,
          reason: params?.reason ?? null
        }
      })
    : null;
  let cancelRetryContext: AtpErrorContext = {
    operation: 'cancel',
    tenantId,
    warehouseIds: [warehouseId],
    itemIds: [],
    lockKeysCount: 0
  };
  let lockedReservation: ReservationRow | null = null;
  let result: any;
  try {
    result = await runInventoryCommand<any | null>({
      tenantId,
      endpoint: IDEMPOTENCY_ENDPOINTS.RESERVATIONS_CANCEL,
      operation: 'cancel',
      idempotencyKey: transactionalIdempotencyKey,
      requestHash,
      retryOptions: buildAtpRetryOptions(cancelRetryContext, ATP_SERIALIZABLE_RETRIES),
      lockTargets: async (client) => {
        lockedReservation = await lockReservationForUpdate(client, tenantId, id, warehouseId);
        const advisoryTargets: AtpLockTarget[] = [{
          tenantId,
          warehouseId: lockedReservation.warehouse_id,
          itemId: lockedReservation.item_id
        }];
        cancelRetryContext = {
          operation: 'cancel',
          tenantId,
          warehouseIds: [lockedReservation.warehouse_id],
          itemIds: [lockedReservation.item_id],
          lockKeysCount: buildAtpLockKeys(advisoryTargets).length
        };
        return advisoryTargets;
      },
      execute: async ({ client }) => {
        const reservation = lockedReservation;
        if (!reservation) {
          throw new Error('RESERVATION_NOT_FOUND');
        }

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

        const deltaReserved = reservation.status === 'RESERVED' ? -remaining : 0;
        const deltaAllocated = reservation.status === 'ALLOCATED' ? -remaining : 0;
        const eventVersion = await insertReservationEvent(
          client,
          tenantId,
          id,
          'CANCELLED',
          deltaReserved,
          deltaAllocated
        );

        const updated = await client.query(
          `SELECT * FROM inventory_reservations
            WHERE id = $1
              AND tenant_id = $2
              AND warehouse_id = $3`,
          [id, tenantId, warehouseId]
        );

        return {
          responseBody: (updated.rowCount ?? 0) > 0 ? mapReservation(updated.rows[0]) : null,
          events: (updated.rowCount ?? 0) > 0
            ? [buildReservationChangedEvent(updated.rows[0], eventVersion, transactionalIdempotencyKey)]
            : [],
          projectionOps: remaining > 0
            ? [
                async (projectionClient: PoolClient) => {
                  await applyInventoryBalanceDelta(projectionClient, {
                    tenantId,
                    itemId: reservation.item_id,
                    locationId: reservation.location_id,
                    uom: reservation.uom,
                    deltaReserved,
                    deltaAllocated
                  });
                }
              ]
            : []
        };
      }
    });
  } catch (error: any) {
    if (error?.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
      throw new Error('RESERVATION_CANCEL_IN_PROGRESS');
    }
    withAtpRetryHandling(error, cancelRetryContext);
  }
  invalidateAtpCacheForWarehouse(tenantId, warehouseId);
  return result;
}

export async function fulfillReservation(
  tenantId: string,
  id: string,
  warehouseId: string,
  params?: { quantity?: number; idempotencyKey?: string | null }
) {
  const now = new Date();
  const transactionalIdempotencyKey =
    typeof params?.idempotencyKey === 'string' && params.idempotencyKey.trim()
      ? params.idempotencyKey.trim()
      : null;
  const requestHash = transactionalIdempotencyKey
    ? hashTransactionalIdempotencyRequest({
        method: 'POST',
        endpoint: IDEMPOTENCY_ENDPOINTS.RESERVATIONS_FULFILL,
        body: {
          reservationId: id,
          warehouseId,
          quantity: params?.quantity ?? null
        }
      })
    : null;
  let fulfillRetryContext: AtpErrorContext = {
    operation: 'fulfill',
    tenantId,
    warehouseIds: [warehouseId],
    itemIds: [],
    lockKeysCount: 0
  };
  let lockedReservation: ReservationRow | null = null;
  let result: any;
  try {
    result = await runInventoryCommand<any | null>({
      tenantId,
      endpoint: IDEMPOTENCY_ENDPOINTS.RESERVATIONS_FULFILL,
      operation: 'fulfill',
      idempotencyKey: transactionalIdempotencyKey,
      requestHash,
      retryOptions: buildAtpRetryOptions(fulfillRetryContext, ATP_SERIALIZABLE_RETRIES),
      lockTargets: async (client) => {
        lockedReservation = await lockReservationForUpdate(client, tenantId, id, warehouseId);
        const advisoryTargets: AtpLockTarget[] = [{
          tenantId,
          warehouseId: lockedReservation.warehouse_id,
          itemId: lockedReservation.item_id
        }];
        fulfillRetryContext = {
          operation: 'fulfill',
          tenantId,
          warehouseIds: [lockedReservation.warehouse_id],
          itemIds: [lockedReservation.item_id],
          lockKeysCount: buildAtpLockKeys(advisoryTargets).length
        };
        return advisoryTargets;
      },
      execute: async ({ client }) => {
        const reservation = lockedReservation;
        if (!reservation) {
          throw new Error('RESERVATION_NOT_FOUND');
        }

        await assertSellableLocationOrThrow(client, tenantId, reservation.location_id, {
          expectedWarehouseId: reservation.warehouse_id
        });
        if (reservation.status !== 'ALLOCATED') {
          throw reservationInvalidState();
        }

        const quantityReserved = toNumber(reservation.quantity_reserved);
        const quantityFulfilled = toNumber(reservation.quantity_fulfilled ?? 0);
        if (quantityFulfilled - quantityReserved > 1e-6) {
          throw reservationInvalidState();
        }
        const remaining = roundQuantity(Math.max(0, quantityReserved - quantityFulfilled));
        if (remaining <= 1e-6) {
          throw reservationInvalidState();
        }

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

        const eventVersion = await insertReservationEvent(client, tenantId, id, 'FULFILLED', 0, -fulfillQty);
        const updated = await client.query(
          `SELECT * FROM inventory_reservations
            WHERE id = $1
              AND tenant_id = $2
              AND warehouse_id = $3`,
          [id, tenantId, warehouseId]
        );

        return {
          responseBody: (updated.rowCount ?? 0) > 0 ? mapReservation(updated.rows[0]) : null,
          events: (updated.rowCount ?? 0) > 0
            ? [buildReservationChangedEvent(updated.rows[0], eventVersion, transactionalIdempotencyKey)]
            : [],
          projectionOps: fulfillQty > 0
            ? [
                async (projectionClient: PoolClient) => {
                  await applyInventoryBalanceDelta(projectionClient, {
                    tenantId,
                    itemId: reservation.item_id,
                    locationId: reservation.location_id,
                    uom: reservation.uom,
                    deltaAllocated: -fulfillQty
                  });
                }
              ]
            : []
        };
      }
    });
  } catch (error: any) {
    if (error?.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
      throw new Error('RESERVATION_FULFILL_IN_PROGRESS');
    }
    withAtpRetryHandling(error, fulfillRetryContext);
  }
  invalidateAtpCacheForWarehouse(tenantId, warehouseId);
  return result;
}

export async function expireReservationsJob() {
  const affectedTenantWarehouses = new Map<string, Set<string>>();
  let expireRetryContext: AtpErrorContext = {
    operation: 'expire',
    tenantId: 'system',
    warehouseIds: [],
    itemIds: [],
    lockKeysCount: 0
  };
  let expiringReservations: ReservationRow[] = [];
  let invalidationTargets: Array<{ tenantId: string; warehouseId: string }> = [];
  try {
    await runInventoryCommand<void>({
      tenantId: 'system',
      endpoint: 'otc.expire_reservations_job',
      operation: 'expire',
      retryOptions: buildAtpRetryOptions(expireRetryContext, 1),
      lockTargets: async (client) => {
        const res = await client.query<ReservationRow>(
          `SELECT id,
                  tenant_id,
                  warehouse_id,
                  status,
                  item_id,
                  location_id,
                  uom,
                  quantity_reserved,
                  quantity_fulfilled,
                  demand_id,
                  demand_type
             FROM inventory_reservations
            WHERE status = 'RESERVED'
              AND expires_at IS NOT NULL
              AND expires_at <= now()
            FOR UPDATE SKIP LOCKED`
        );
        expiringReservations = [...res.rows].sort(compareReservationMutationScope);
        const advisoryTargets: AtpLockTarget[] = expiringReservations
          .filter((row) => typeof row.warehouse_id === 'string' && row.warehouse_id.length > 0)
          .map((row) => ({
            tenantId: row.tenant_id,
            warehouseId: row.warehouse_id,
            itemId: row.item_id
          }));
        expireRetryContext = {
          operation: 'expire',
          tenantId: advisoryTargets[0]?.tenantId ?? 'system',
          warehouseIds: mapUniqueValues(advisoryTargets.map((target) => target.warehouseId)),
          itemIds: mapUniqueValues(advisoryTargets.map((target) => target.itemId)),
          lockKeysCount: buildAtpLockKeys(advisoryTargets).length
        };
        return advisoryTargets;
      },
      execute: async ({ client }) => {
        const now = new Date();
        const events: InventoryCommandEvent[] = [];
        const projectionOps: InventoryCommandProjectionOp[] = [];
        invalidationTargets = [];

        for (const row of expiringReservations) {
          const remaining = roundQuantity(
            Math.max(0, toNumber(row.quantity_reserved) - toNumber(row.quantity_fulfilled ?? 0))
          );
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

          if (typeof row.warehouse_id === 'string' && row.warehouse_id.length > 0) {
            invalidationTargets.push({ tenantId: row.tenant_id, warehouseId: row.warehouse_id });
          }
          if (remaining > 0) {
            projectionOps.push(
              buildInventoryBalanceProjectionOp({
                tenantId: row.tenant_id,
                itemId: row.item_id,
                locationId: row.location_id,
                uom: row.uom,
                deltaReserved: -remaining
              })
            );
          }
          const eventVersion = await insertReservationEvent(client, row.tenant_id, row.id, 'EXPIRED', -remaining, 0);
          events.push({
            ...buildReservationChangedEvent(
              { ...row, status: 'EXPIRED' },
              eventVersion
            ),
            tenantId: row.tenant_id
          });
        }

        return {
          responseBody: undefined,
          events,
          projectionOps
        };
      }
    });
  } catch (error) {
    withAtpRetryHandling(error, expireRetryContext);
  }
  for (const target of invalidationTargets) {
    const warehousesForTenant = affectedTenantWarehouses.get(target.tenantId) ?? new Set<string>();
    warehousesForTenant.add(target.warehouseId);
    affectedTenantWarehouses.set(target.tenantId, warehousesForTenant);
  }
  for (const [tenantId, warehouseIds] of affectedTenantWarehouses.entries()) {
    for (const warehouseId of warehouseIds.values()) {
      invalidateAtpCacheForWarehouse(tenantId, warehouseId);
    }
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

async function validateShipmentWarehouseScope(
  client: PoolClient,
  tenantId: string,
  salesOrderId: string,
  shipFromLocationId?: string | null
): Promise<ShipmentWarehouseScope> {
  if (!shipFromLocationId) {
    return {
      salesOrderWarehouseId: null,
      shipFromWarehouseId: null
    };
  }

  const orderRes = await client.query<{ warehouse_id: string | null }>(
    `SELECT warehouse_id
       FROM sales_orders
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1`,
    [tenantId, salesOrderId]
  );
  const salesOrderWarehouseId = orderRes.rows[0]?.warehouse_id ?? null;
  const shipFromWarehouseId = await resolveWarehouseIdForLocation(tenantId, shipFromLocationId, client);
  if (!salesOrderWarehouseId || !shipFromWarehouseId) {
    throw new Error('WAREHOUSE_SCOPE_REQUIRED');
  }
  if (salesOrderWarehouseId !== shipFromWarehouseId) {
    throw new Error('WAREHOUSE_SCOPE_MISMATCH');
  }
  return {
    salesOrderWarehouseId,
    shipFromWarehouseId
  };
}

async function loadShipmentSalesOrderLines(
  client: PoolClient,
  tenantId: string,
  salesOrderId: string,
  lineIds: string[],
  options?: { forUpdate?: boolean }
) {
  const uniqueLineIds = Array.from(new Set(lineIds)).sort((left, right) => left.localeCompare(right));
  const res = await client.query<ShipmentSalesOrderLineRow>(
    `SELECT id, item_id
       FROM sales_order_lines
      WHERE tenant_id = $1
        AND sales_order_id = $2
        AND id = ANY($3::uuid[])
      ORDER BY id ASC
      ${options?.forUpdate ? 'FOR UPDATE' : ''}`,
    [tenantId, salesOrderId, uniqueLineIds]
  );
  if (res.rowCount !== uniqueLineIds.length) {
    throw new Error('SHIPMENT_LINE_INVALID_REFERENCE');
  }
  return res.rows;
}

async function insertShipmentDocument(
  client: PoolClient,
  tenantId: string,
  shipmentId: string,
  data: ShipmentInput,
  now: Date,
  preparedLines: PreparedShipmentLineInput[]
) {
  const shipment = await client.query(
    `INSERT INTO sales_order_shipments (
      id, tenant_id, sales_order_id, shipped_at, ship_from_location_id, inventory_movement_id, external_ref, notes, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *`,
    [
      shipmentId,
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
  for (const line of preparedLines) {
    const lineResult = await client.query(
      `INSERT INTO sales_order_shipment_lines (
        id, tenant_id, sales_order_shipment_id, sales_order_line_id, uom, quantity_shipped
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [line.id, tenantId, shipmentId, line.salesOrderLineId, line.uom, line.quantityShipped],
    );
    lines.push(lineResult.rows[0]);
  }

  return {
    shipment: shipment.rows[0],
    lines
  };
}

export async function createShipment(tenantId: string, data: ShipmentInput) {
  const now = new Date();
  const id = uuidv4();
  const preparedLines: PreparedShipmentLineInput[] = data.lines.map((line) => ({
    ...line,
    id: uuidv4()
  }));

  if (data.autoAllocateReservations) {
    let createRetryContext: AtpErrorContext = {
      operation: 'shipment_create_allocate',
      tenantId,
      warehouseIds: [],
      itemIds: [],
      lockKeysCount: 0
    };
    let salesOrderLines: ShipmentSalesOrderLineRow[] = [];
    let shipFromWarehouseId: string | null = null;
    let salesOrderWarehouseId: string | null = null;
    let createdShipment: any;

    try {
      createdShipment = await runInventoryCommand<any>({
        tenantId,
        endpoint: IDEMPOTENCY_ENDPOINTS.RESERVATIONS_ALLOCATE,
        operation: 'shipment_create_allocate',
        retryOptions: buildAtpRetryOptions(createRetryContext, ATP_SERIALIZABLE_RETRIES),
        lockTargets: async (client) => {
          if (!data.shipFromLocationId) {
            throw new Error('SHIPMENT_LOCATION_REQUIRED');
          }

          const scope = await validateShipmentWarehouseScope(
            client,
            tenantId,
            data.salesOrderId,
            data.shipFromLocationId
          );
          salesOrderWarehouseId = scope.salesOrderWarehouseId;
          shipFromWarehouseId = scope.shipFromWarehouseId;
          if (!shipFromWarehouseId || !salesOrderWarehouseId) {
            throw new Error('WAREHOUSE_SCOPE_REQUIRED');
          }

          await assertSellableLocationOrThrow(client, tenantId, data.shipFromLocationId, {
            expectedWarehouseId: shipFromWarehouseId
          });

          salesOrderLines = await loadShipmentSalesOrderLines(
            client,
            tenantId,
            data.salesOrderId,
            preparedLines.map((line) => line.salesOrderLineId),
            { forUpdate: true }
          );
          const itemIds = mapUniqueValues(salesOrderLines.map((line) => line.item_id));
          const advisoryTargets = itemIds.map((itemId) => ({
            tenantId,
            warehouseId: shipFromWarehouseId!,
            itemId
          }));
          createRetryContext = {
            operation: 'shipment_create_allocate',
            tenantId,
            warehouseIds: [shipFromWarehouseId],
            itemIds,
            lockKeysCount: buildAtpLockKeys(advisoryTargets).length
          };
          return advisoryTargets;
        },
        execute: async ({ client }) => {
          if (!shipFromWarehouseId) {
            throw new Error('WAREHOUSE_SCOPE_REQUIRED');
          }

          const { shipment, lines } = await insertShipmentDocument(
            client,
            tenantId,
            id,
            data,
            now,
            preparedLines
          );

          const lineRowsById = new Map(salesOrderLines.map((line) => [line.id, line]));
          const demandIds = mapUniqueValues(preparedLines.map((line) => line.salesOrderLineId));
          const reservationsRes = await client.query<ReservationRow>(
            `SELECT *
               FROM inventory_reservations
              WHERE tenant_id = $1
                AND warehouse_id = $2
                AND demand_type = 'sales_order_line'
                AND demand_id = ANY($3::uuid[])
                AND location_id = $4
              ORDER BY demand_id ASC, item_id ASC, uom ASC, id ASC
              FOR UPDATE`,
            [tenantId, shipFromWarehouseId, demandIds, data.shipFromLocationId]
          );
          const reservationsByKey = new Map<string, ReservationRow>();
          for (const reservation of reservationsRes.rows) {
            reservationsByKey.set(
              [
                reservation.demand_id,
                reservation.item_id,
                reservation.location_id,
                reservation.uom
              ].join(':'),
              reservation
            );
          }

          const events: InventoryCommandEvent[] = [];
          const projectionOps: InventoryCommandProjectionOp[] = [];

          for (const line of preparedLines) {
            const salesOrderLine = lineRowsById.get(line.salesOrderLineId);
            if (!salesOrderLine) {
              throw new Error('SHIPMENT_LINE_INVALID_REFERENCE');
            }
            const canonicalRequested = await convertToCanonical(
              tenantId,
              salesOrderLine.item_id,
              line.quantityShipped,
              line.uom,
              client
            );
            const shipmentQty = roundQuantity(Math.max(0, canonicalRequested.quantity));
            if (shipmentQty <= 1e-6) {
              continue;
            }

            const reservation = reservationsByKey.get(
              [
                line.salesOrderLineId,
                salesOrderLine.item_id,
                data.shipFromLocationId,
                canonicalRequested.canonicalUom
              ].join(':')
            );
            if (!reservation || reservation.status !== 'RESERVED') {
              continue;
            }

            const openQty = roundQuantity(
              Math.max(0, toNumber(reservation.quantity_reserved) - toNumber(reservation.quantity_fulfilled ?? 0))
            );
            if (openQty <= 1e-6 || openQty - shipmentQty > 1e-6) {
              continue;
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
              [now, reservation.id, tenantId, shipFromWarehouseId]
            );
            if (transition.rowCount === 0) {
              throw reservationInvalidState();
            }

            const eventVersion = await insertReservationEvent(
              client,
              tenantId,
              reservation.id,
              'ALLOCATED',
              -openQty,
              openQty
            );
            const updated = await client.query(
              `SELECT *
                 FROM inventory_reservations
                WHERE id = $1
                  AND tenant_id = $2
                  AND warehouse_id = $3`,
              [reservation.id, tenantId, shipFromWarehouseId]
            );
            const updatedReservation = updated.rows[0] ?? {
              ...reservation,
              status: 'ALLOCATED',
              allocated_at: now,
              updated_at: now
            };

            events.push(buildReservationChangedEvent(updatedReservation, eventVersion));
            projectionOps.push(
              buildInventoryBalanceProjectionOp({
                tenantId,
                itemId: reservation.item_id,
                locationId: reservation.location_id,
                uom: reservation.uom,
                deltaReserved: -openQty,
                deltaAllocated: openQty
              })
            );
          }

          return {
            responseBody: mapShipment(shipment, lines),
            responseStatus: 201,
            events,
            projectionOps
          };
        }
      });
    } catch (error) {
      withAtpRetryHandling(error, createRetryContext);
    }
    if (shipFromWarehouseId) {
      invalidateAtpCacheForWarehouse(tenantId, shipFromWarehouseId);
    }
    return createdShipment;
  }

  return withTransaction(async (client) => {
    await validateShipmentWarehouseScope(client, tenantId, data.salesOrderId, data.shipFromLocationId);
    const { shipment, lines } = await insertShipmentDocument(client, tenantId, id, data, now, preparedLines);
    return mapShipment(shipment, lines);
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

async function repairShipmentReplayAggregateState(params: {
  client: PoolClient;
  tenantId: string;
  shipmentId: string;
  movementId: string;
  idempotencyKey: string;
}) {
  const now = new Date();
  await params.client.query(
    `UPDATE sales_order_shipments
        SET inventory_movement_id = COALESCE(inventory_movement_id, $1),
            status = 'posted',
            posted_at = COALESCE(posted_at, $2),
            posted_idempotency_key = COALESCE(posted_idempotency_key, $3)
      WHERE id = $4
        AND tenant_id = $5`,
    [params.movementId, now, params.idempotencyKey, params.shipmentId, params.tenantId]
  );
}

async function buildShipmentReplayResult(params: {
  tenantId: string;
  shipmentId: string;
  movementId: string;
  expectedLineCount: number;
  idempotencyKey: string;
  client: PoolClient;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      {
        movementId: params.movementId,
        expectedLineCount: params.expectedLineCount
      }
    ],
    client: params.client,
    preFetchIntegrityCheck: async () => {
      await repairShipmentReplayAggregateState({
        client: params.client,
        tenantId: params.tenantId,
        shipmentId: params.shipmentId,
        movementId: params.movementId,
        idempotencyKey: params.idempotencyKey
      });
    },
    fetchAggregateView: () => getShipment(params.tenantId, params.shipmentId, params.client),
    aggregateNotFoundError: new Error('SHIPMENT_NOT_FOUND'),
    authoritativeEvents: [
      buildMovementPostedEvent(params.movementId, params.idempotencyKey)
    ],
    responseStatus: 200
  });
}

export async function postShipment(
  tenantId: string,
  shipmentId: string,
  params: {
    idempotencyKey: string;
    actor?: { type: 'user' | 'system'; id?: string | null; role?: string | null };
    overrideRequested?: boolean;
    overrideReason?: string | null;
    internalHooks?: PostShipmentInternalHooks;
  }
) {
  if (!params.idempotencyKey) {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  }
  const transactionalIdempotencyKey = params.idempotencyKey.trim();
  const requestHash = hashTransactionalIdempotencyRequest({
    method: 'POST',
    endpoint: IDEMPOTENCY_ENDPOINTS.SHIPMENTS_POST,
    body: {
      shipmentId,
      overrideRequested: !!params.overrideRequested,
      overrideReason: params.overrideReason ?? null
    }
  });

  let shipmentRetryContext: AtpErrorContext = {
    operation: 'shipment_post',
    tenantId,
    warehouseIds: [],
    itemIds: [],
    lockKeysCount: 0
  };
  let shipment: any = null;
  let shipmentLines: any[] = [];
  let shipmentLineContexts: Array<{
    line: any;
    canonicalOut: Awaited<ReturnType<typeof getCanonicalMovementFields>>;
    issueQty: number;
    reservationId: string | null;
    reservation: ReservationRow | null;
    reserveConsume: number;
  }> = [];
  let reservationIdsToLock: string[] = [];
  let shipFromWarehouseId: string | null = null;
  let shipmentAlreadyPosted = false;
  let result: any;
  try {
    result = await runInventoryCommand<any>({
      tenantId,
      endpoint: IDEMPOTENCY_ENDPOINTS.SHIPMENTS_POST,
      operation: 'shipment_post',
      idempotencyKey: transactionalIdempotencyKey,
      requestHash,
      retryOptions: buildAtpRetryOptions(shipmentRetryContext, ATP_SHIPMENT_POST_RETRIES),
      onReplay: async ({ client, responseBody }) => {
        const replayMovementId = responseBody?.inventoryMovementId;
        if (typeof replayMovementId !== 'string' || !replayMovementId) {
          throw buildReplayCorruptionError({
            tenantId,
            shipmentId,
            idempotencyKey: transactionalIdempotencyKey,
            reason: 'shipment_replay_movement_missing'
          });
        }
        return (
          await buildShipmentReplayResult({
            tenantId,
            shipmentId,
            movementId: replayMovementId,
            expectedLineCount: Array.isArray(responseBody?.lines) ? responseBody.lines.length : 0,
            idempotencyKey: transactionalIdempotencyKey,
            client
          })
        ).responseBody;
      },
      lockTargets: async (client) => {
        shipmentAlreadyPosted = false;
        shipment = null;
        shipmentLines = [];
        shipmentLineContexts = [];
        reservationIdsToLock = [];
        shipFromWarehouseId = null;

        const shipmentRes = await client.query(
          `SELECT * FROM sales_order_shipments WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [shipmentId, tenantId]
        );
        if (shipmentRes.rowCount === 0) {
          throw new Error('SHIPMENT_NOT_FOUND');
        }
        shipment = shipmentRes.rows[0];
        if (shipment.status === 'canceled') {
          throw new Error('SHIPMENT_CANCELED');
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
        shipmentLines = linesRes.rows;
        const detectedShipmentAlreadyPosted = shipment.inventory_movement_id || shipment.status === 'posted';
        if (params.internalHooks?.onLoaded) {
          await params.internalHooks.onLoaded({
            client,
            shipment,
            shipmentLines,
            shipmentAlreadyPosted: !!detectedShipmentAlreadyPosted
          });
        }
        if (shipment.inventory_movement_id || shipment.status === 'posted') {
          shipmentAlreadyPosted = true;
          shipmentRetryContext = {
            operation: 'shipment_post',
            tenantId,
            warehouseIds: [],
            itemIds: [],
            lockKeysCount: 0
          };
          return [];
        }
        if (!shipment.ship_from_location_id) {
          throw new Error('SHIPMENT_LOCATION_REQUIRED');
        }

        shipFromWarehouseId = await resolveWarehouseIdForLocation(tenantId, shipment.ship_from_location_id, client);
        if (!shipFromWarehouseId) {
          throw new Error('WAREHOUSE_SCOPE_REQUIRED');
        }
        await assertSellableLocationOrThrow(client, tenantId, shipment.ship_from_location_id);
        const salesOrderWarehouseRes = await client.query<{ warehouse_id: string | null }>(
          `SELECT warehouse_id
             FROM sales_orders
            WHERE id = $1
              AND tenant_id = $2
            LIMIT 1`,
          [shipment.sales_order_id, tenantId]
        );
        const salesOrderWarehouseId = salesOrderWarehouseRes.rows[0]?.warehouse_id ?? null;
        if (!salesOrderWarehouseId) {
          throw new Error('WAREHOUSE_SCOPE_REQUIRED');
        }
        if (salesOrderWarehouseId !== shipFromWarehouseId) {
          throw new Error('CROSS_WAREHOUSE_LEAKAGE_BLOCKED');
        }

        const reservationIdsToLockSet = new Set<string>();
        for (const line of shipmentLines) {
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
            reservationIdsToLockSet.add(reservationId);
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
        shipmentLineContexts.sort((left, right) => {
          const item = left.line.item_id.localeCompare(right.line.item_id);
          if (item !== 0) return item;
          const uom = left.canonicalOut.canonicalUom.localeCompare(right.canonicalOut.canonicalUom);
          if (uom !== 0) return uom;
          return String(left.line.id).localeCompare(String(right.line.id));
        });
        reservationIdsToLock = Array.from(reservationIdsToLockSet).sort((left, right) => left.localeCompare(right));

        const advisoryTargets: AtpLockTarget[] = shipmentLineContexts.map((lineContext) => ({
          tenantId,
          warehouseId: shipFromWarehouseId!,
          itemId: lineContext.line.item_id
        }));
        shipmentRetryContext = {
          operation: 'shipment_post',
          tenantId,
          warehouseIds: [shipFromWarehouseId],
          itemIds: mapUniqueValues(shipmentLineContexts.map((lineContext) => lineContext.line.item_id)),
          lockKeysCount: buildAtpLockKeys(advisoryTargets).length
        };
        return advisoryTargets;
      },
      execute: async ({ client, lockContext }) => {
        if (!shipment) {
          throw new Error('SHIPMENT_NOT_FOUND');
        }
        if (shipmentAlreadyPosted) {
          if (!shipment.inventory_movement_id) {
            throw buildReplayCorruptionError({
              tenantId,
              shipmentId,
              reason: 'shipment_posted_without_movement'
            });
          }
          const replayed = await buildShipmentReplayResult({
            tenantId,
            shipmentId,
            movementId: shipment.inventory_movement_id,
            expectedLineCount: shipmentLines.length,
            idempotencyKey: transactionalIdempotencyKey,
            client
          });
          if (params.internalHooks?.afterPost) {
            await params.internalHooks.afterPost({
              client,
              shipment,
              shipmentLines,
              movementId: shipment.inventory_movement_id,
              occurredAt: new Date(),
              idempotencyKey: transactionalIdempotencyKey
            });
          }
          return replayed;
        }
        if (!shipFromWarehouseId) {
          throw new Error('WAREHOUSE_SCOPE_REQUIRED');
        }

        const now = new Date();
        const lockedReservations = await lockReservationsForUpdate(
          client,
          tenantId,
          shipFromWarehouseId,
          reservationIdsToLock
        );
        const lockedReservationsById = new Map(lockedReservations.map((row) => [row.id, row]));

        const stockValidationLines: {
          warehouseId: string;
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
            warehouseId: shipFromWarehouseId!,
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
            throw atpInsufficientAvailable({
              operation: 'shipment_post',
              tenantId,
              warehouseId: shipFromWarehouseId,
              itemId: stockValidationLines[0]?.itemId ?? null,
              shipmentId,
              available: null,
              requested: stockValidationLines.reduce((sum, line) => sum + Number(line.quantityToConsume ?? 0), 0),
              reason: 'stock_validation_failed',
              details: error?.details ?? null
            });
          }
          throw error;
        }

        const movementId = uuidv4();
        const plannedShipmentLines: Array<{
          line: (typeof shipmentLineContexts)[number]['line'];
          canonicalOut: (typeof shipmentLineContexts)[number]['canonicalOut'];
          issueQty: number;
          reservation: (typeof shipmentLineContexts)[number]['reservation'];
          reserveConsume: number;
          consumptionPlan: Awaited<ReturnType<typeof planCostLayerConsumption>>;
          unitCost: number | null;
          extendedCost: number | null;
        }> = [];
        for (const lineContext of shipmentLineContexts) {
          const { line, canonicalOut, issueQty, reservation, reserveConsume } = lineContext;

          const canonicalAvailability = await getCanonicalAvailability(
            client,
            tenantId,
            shipFromWarehouseId,
            line.item_id,
            shipment.ship_from_location_id,
            canonicalOut.canonicalUom,
            lockContext
          );
          const shipmentAvailable = roundQuantity(canonicalAvailability.available);
          if (!canShipWithReservationAllowance(shipmentAvailable, reserveConsume, issueQty) && !validation.overrideMetadata) {
            throw atpInsufficientAvailable({
              operation: 'shipment_post',
              tenantId,
              warehouseId: shipFromWarehouseId,
              itemId: line.item_id,
              locationId: shipment.ship_from_location_id,
              uom: canonicalOut.canonicalUom,
              shipmentId,
              shipmentLineId: line.id,
              available: shipmentAvailable,
              requested: issueQty,
              reserveConsume,
              reason: 'shipment_allowance_exceeded'
            });
          }

          const consumptionPlan = await planCostLayerConsumption({
            tenant_id: tenantId,
            item_id: line.item_id,
            location_id: shipment.ship_from_location_id,
            quantity: issueQty,
            consumption_type: 'sale',
            consumption_document_id: shipmentId,
            movement_id: movementId,
            client
          });
          plannedShipmentLines.push({
            line,
            canonicalOut,
            issueQty,
            reservation,
            reserveConsume,
            consumptionPlan,
            unitCost: issueQty !== 0 ? consumptionPlan.total_cost / issueQty : null,
            extendedCost: consumptionPlan.total_cost !== null ? -consumptionPlan.total_cost : null
          });
        }

        const movement = await persistInventoryMovement(client, {
          id: movementId,
          tenantId,
          movementType: 'issue',
          status: 'posted',
          externalRef: `shipment:${shipmentId}`,
          sourceType: 'shipment_post',
          sourceId: shipmentId,
          idempotencyKey: transactionalIdempotencyKey,
          occurredAt: shipment.shipped_at ?? now,
          postedAt: now,
          notes: shipment.notes ?? null,
          metadata: validation.overrideMetadata ?? null,
          createdAt: now,
        updatedAt: now,
        lines: plannedShipmentLines.map((lineContext) => ({
          sourceLineId: lineContext.line.id,
          eventTimestamp: shipment.shipped_at ?? now,
          warehouseId: shipFromWarehouseId!,
          itemId: lineContext.line.item_id,
            locationId: shipment.ship_from_location_id,
            quantityDelta: lineContext.canonicalOut.quantityDeltaCanonical,
            uom: lineContext.canonicalOut.canonicalUom,
            quantityDeltaEntered: lineContext.canonicalOut.quantityDeltaEntered,
            uomEntered: lineContext.canonicalOut.uomEntered,
            quantityDeltaCanonical: lineContext.canonicalOut.quantityDeltaCanonical,
            canonicalUom: lineContext.canonicalOut.canonicalUom,
            uomDimension: lineContext.canonicalOut.uomDimension,
            unitCost: lineContext.unitCost,
            extendedCost: lineContext.extendedCost,
            reasonCode: 'shipment',
            lineNotes: `Shipment ${shipmentId} line ${lineContext.line.id}`,
            createdAt: now
          }))
        });

        const events: InventoryCommandEvent[] = [];
        const projectionOps: InventoryCommandProjectionOp[] = [];
        const itemsToRefresh = new Set<string>();

        if (!movement.created) {
          const replayed = await buildShipmentReplayResult({
            tenantId,
            shipmentId,
            movementId: movement.movementId,
            expectedLineCount: shipmentLines.length,
            idempotencyKey: transactionalIdempotencyKey,
            client
          });
          if (params.internalHooks?.afterPost) {
            await params.internalHooks.afterPost({
              client,
              shipment,
              shipmentLines,
              movementId: movement.movementId,
              occurredAt: now,
              idempotencyKey: transactionalIdempotencyKey
            });
          }
          return replayed;
        }

        for (const lineContext of plannedShipmentLines) {
          const { line, canonicalOut, issueQty, reservation, reserveConsume, consumptionPlan } = lineContext;

          await applyPlannedCostLayerConsumption({
            tenant_id: tenantId,
            item_id: line.item_id,
            location_id: shipment.ship_from_location_id,
            quantity: issueQty,
            consumption_type: 'sale',
            consumption_document_id: shipmentId,
            movement_id: movement.movementId,
            client,
            plan: consumptionPlan
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

            projectionOps.push(
              buildInventoryBalanceProjectionOp({
                tenantId,
                itemId: line.item_id,
                locationId: shipment.ship_from_location_id,
                uom: canonicalOut.canonicalUom,
                deltaReserved: -reserveConsume,
                deltaAllocated: reserveConsume
              })
            );
            await insertReservationEvent(client, tenantId, reservation.id, 'ALLOCATED', -reserveConsume, reserveConsume);
            reservation.status = 'ALLOCATED';
          }

          projectionOps.push(
            buildInventoryBalanceProjectionOp({
              tenantId,
              itemId: line.item_id,
              locationId: shipment.ship_from_location_id,
              uom: canonicalOut.canonicalUom,
              deltaOnHand: -issueQty,
              deltaAllocated: -reserveConsume
            })
          );
          itemsToRefresh.add(line.item_id);

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

            const eventVersion = await insertReservationEvent(
              client,
              tenantId,
              reservation.id,
              newStatus === 'FULFILLED' ? 'FULFILLED' : 'ALLOCATED',
              0,
              -reserveConsume
            );
            reservation.quantity_fulfilled = fulfilled;
            reservation.status = newStatus;
            events.push(buildReservationChangedEvent(reservation, eventVersion, transactionalIdempotencyKey));
          }
        }

        for (const itemId of itemsToRefresh.values()) {
          projectionOps.push(buildRefreshItemCostSummaryProjectionOp(tenantId, itemId));
        }

        await client.query(
          `UPDATE sales_order_shipments
              SET inventory_movement_id = $1,
                  status = 'posted',
                  posted_at = $2,
                  posted_idempotency_key = $3
            WHERE id = $4 AND tenant_id = $5`,
          [movement.movementId, now, transactionalIdempotencyKey, shipmentId, tenantId]
        );

        if (params.internalHooks?.afterPost) {
          await params.internalHooks.afterPost({
            client,
            shipment,
            shipmentLines,
            movementId: movement.movementId,
            occurredAt: now,
            idempotencyKey: transactionalIdempotencyKey
          });
        }

        events.push(buildMovementPostedEvent(movement.movementId, transactionalIdempotencyKey));

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
              metadata: { movementId: movement.movementId }
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
              entityId: movement.movementId,
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

        return {
          responseBody: await getShipment(tenantId, shipmentId, client),
          responseStatus: 200,
          events,
          projectionOps
        };
      }
    });
  } catch (error) {
    if ((error as StructuredServiceError)?.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
      throw error;
    }
    withAtpRetryHandling(error, shipmentRetryContext);
  }

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
