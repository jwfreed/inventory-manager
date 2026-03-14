import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { recordAuditLog } from '../lib/audit';
import { convertToCanonical } from './uomCanonical.service';
import { deriveComponentConsumeLocation, deriveWorkOrderStageRouting } from './stageRouting.service';
import { fetchBomById, resolveEffectiveBom } from './boms.service';

type WorkOrderRow = {
  id: string;
  tenant_id: string;
  status: string;
  kind: string;
  bom_id: string | null;
  output_item_id: string;
  output_uom: string;
  quantity_planned: string | number;
  quantity_completed: string | number | null;
  quantity_scrapped: string | number | null;
  default_consume_location_id: string | null;
  default_produce_location_id: string | null;
  produce_to_location_id_snapshot: string | null;
};

type ReservationRow = {
  id: string;
  tenant_id: string;
  client_id: string;
  status: string;
  demand_type: string;
  demand_id: string;
  item_id: string;
  location_id: string;
  warehouse_id: string;
  uom: string;
  quantity_reserved: string | number;
  quantity_fulfilled: string | number | null;
  reserved_at: string;
  released_at: string | null;
  release_reason_code: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  idempotency_key?: string | null;
  allocated_at?: string | null;
  canceled_at?: string | null;
  fulfilled_at?: string | null;
  expires_at?: string | null;
  expired_at?: string | null;
  cancel_reason?: string | null;
};

type ReservationStateRow = Pick<
  ReservationRow,
  | 'status'
  | 'quantity_fulfilled'
  | 'updated_at'
  | 'fulfilled_at'
  | 'released_at'
  | 'canceled_at'
  | 'release_reason_code'
  | 'cancel_reason'
  | 'allocated_at'
>;

export type WorkOrderReservationPlanLine = {
  componentItemId: string;
  componentItemSku: string | null;
  componentItemName: string | null;
  locationId: string;
  locationCode: string | null;
  locationName: string | null;
  locationRole: string | null;
  warehouseId: string;
  uom: string;
  requiredQty: number;
};

export type WorkOrderReservationSnapshotLine = WorkOrderReservationPlanLine & {
  reservationId: string | null;
  reservationStatus: string | null;
  reservedQty: number;
  fulfilledQty: number;
  openReservedQty: number;
  availableQty: number;
  shortageQty: number;
};

type WorkOrderReservationPlan = {
  workOrder: WorkOrderRow;
  stageType: string;
  stageLabel: string;
  remainingQuantity: number;
  lines: WorkOrderReservationPlanLine[];
};

function workOrderPlanningRemainingQuantity(workOrder: WorkOrderRow) {
  const planned = roundQuantity(toNumber(workOrder.quantity_planned));
  const completed = roundQuantity(toNumber(workOrder.quantity_completed ?? 0));
  const scrapped = roundQuantity(toNumber(workOrder.quantity_scrapped ?? 0));
  return roundQuantity(Math.max(0, planned - completed - scrapped));
}

async function loadWorkOrderRow(
  tenantId: string,
  workOrderId: string,
  client?: PoolClient
): Promise<WorkOrderRow | null> {
  const executor = client ? client.query.bind(client) : query;
  const result = await executor<WorkOrderRow>(
    `SELECT id,
            tenant_id,
            status,
            kind,
            bom_id,
            output_item_id,
            output_uom,
            quantity_planned,
            quantity_completed,
            quantity_scrapped,
            default_consume_location_id,
            default_produce_location_id,
            produce_to_location_id_snapshot
       FROM work_orders
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, workOrderId]
  );
  return result.rows[0] ?? null;
}

async function loadItemLabel(
  tenantId: string,
  itemId: string,
  client?: PoolClient
): Promise<{ sku: string | null; name: string | null }> {
  const executor = client ? client.query.bind(client) : query;
  const result = await executor<{ sku: string | null; name: string | null }>(
    `SELECT sku, name
       FROM items
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, itemId]
  );
  return result.rows[0] ?? { sku: null, name: null };
}

async function buildProductionReservationPlan(
  tenantId: string,
  workOrder: WorkOrderRow,
  requestedQuantity: number,
  client?: PoolClient
): Promise<WorkOrderReservationPlanLine[]> {
  const { getWorkOrderRequirements } = await import('./workOrders.service');
  const requirements = await getWorkOrderRequirements(tenantId, workOrder.id, requestedQuantity);
  if (!requirements) {
    return [];
  }

  const aggregate = new Map<string, WorkOrderReservationPlanLine>();
  for (const line of requirements.lines) {
    const consumeLocation = await deriveComponentConsumeLocation(
      tenantId,
      {
        kind: workOrder.kind,
        outputItemId: workOrder.output_item_id,
        bomId: workOrder.bom_id,
        defaultConsumeLocationId: workOrder.default_consume_location_id,
        defaultProduceLocationId: workOrder.default_produce_location_id,
        produceToLocationIdSnapshot: workOrder.produce_to_location_id_snapshot
      },
      { componentItemId: line.componentItemId },
      client
    );
    if (!consumeLocation) {
      continue;
    }
    const itemLabel = await loadItemLabel(tenantId, line.componentItemId, client);
    const key = [line.componentItemId, consumeLocation.id, line.uom].join(':');
    const existing = aggregate.get(key);
    if (existing) {
      existing.requiredQty = roundQuantity(existing.requiredQty + line.quantityRequired);
      continue;
    }
    aggregate.set(key, {
      componentItemId: line.componentItemId,
      componentItemSku: itemLabel.sku,
      componentItemName: itemLabel.name,
      locationId: consumeLocation.id,
      locationCode: consumeLocation.code,
      locationName: consumeLocation.name,
      locationRole: consumeLocation.role,
      warehouseId: consumeLocation.warehouseId,
      uom: line.uom,
      requiredQty: roundQuantity(line.quantityRequired)
    });
  }
  return [...aggregate.values()].sort((left, right) =>
    [
      left.componentItemId.localeCompare(right.componentItemId),
      left.locationId.localeCompare(right.locationId),
      left.uom.localeCompare(right.uom)
    ].find((value) => value !== 0) ?? 0
  );
}

async function buildDisassemblyReservationPlan(
  tenantId: string,
  workOrder: WorkOrderRow,
  requestedQuantity: number,
  client?: PoolClient
): Promise<WorkOrderReservationPlanLine[]> {
  const routing = await deriveWorkOrderStageRouting(
    tenantId,
    {
      kind: workOrder.kind,
      outputItemId: workOrder.output_item_id,
      bomId: workOrder.bom_id,
      defaultConsumeLocationId: workOrder.default_consume_location_id,
      defaultProduceLocationId: workOrder.default_produce_location_id,
      produceToLocationIdSnapshot: workOrder.produce_to_location_id_snapshot
    },
    client
  );
  if (!routing.defaultConsumeLocation) {
    return [];
  }
  const itemLabel = await loadItemLabel(tenantId, workOrder.output_item_id, client);
  const normalizedRequested = await convertToCanonical(
    tenantId,
    workOrder.output_item_id,
    requestedQuantity,
    workOrder.output_uom
  );
  return [
    {
      componentItemId: workOrder.output_item_id,
      componentItemSku: itemLabel.sku,
      componentItemName: itemLabel.name,
      locationId: routing.defaultConsumeLocation.id,
      locationCode: routing.defaultConsumeLocation.code,
      locationName: routing.defaultConsumeLocation.name,
      locationRole: routing.defaultConsumeLocation.role,
      warehouseId: routing.defaultConsumeLocation.warehouseId,
      uom: normalizedRequested.canonicalUom,
      requiredQty: roundQuantity(normalizedRequested.quantity)
    }
  ];
}

export async function buildWorkOrderReservationPlan(
  tenantId: string,
  workOrderId: string,
  client?: PoolClient
): Promise<WorkOrderReservationPlan | null> {
  const workOrder = await loadWorkOrderRow(tenantId, workOrderId, client);
  if (!workOrder) {
    return null;
  }
  const remainingQuantity = workOrderPlanningRemainingQuantity(workOrder);
  const routing = await deriveWorkOrderStageRouting(
    tenantId,
    {
      kind: workOrder.kind,
      outputItemId: workOrder.output_item_id,
      bomId: workOrder.bom_id,
      defaultConsumeLocationId: workOrder.default_consume_location_id,
      defaultProduceLocationId: workOrder.default_produce_location_id,
      produceToLocationIdSnapshot: workOrder.produce_to_location_id_snapshot
    },
    client
  );
  const lines =
    remainingQuantity <= 0
      ? []
      : workOrder.kind === 'disassembly'
        ? await buildDisassemblyReservationPlan(tenantId, workOrder, remainingQuantity, client)
        : await buildProductionReservationPlan(tenantId, workOrder, remainingQuantity, client);
  return {
    workOrder,
    stageType: routing.stageType,
    stageLabel: routing.stageLabel,
    remainingQuantity,
    lines
  };
}

async function loadExistingReservations(
  client: PoolClient,
  tenantId: string,
  workOrderId: string
) {
  const result = await client.query<ReservationRow>(
    `SELECT id,
            tenant_id,
            client_id,
            status,
            demand_type,
            demand_id,
            item_id,
            location_id,
            warehouse_id,
            uom,
            quantity_reserved,
            quantity_fulfilled,
            reserved_at,
            released_at,
            release_reason_code,
            notes,
            created_at,
            updated_at,
            idempotency_key,
            allocated_at,
            canceled_at,
            fulfilled_at,
            expires_at,
            expired_at,
            cancel_reason
       FROM inventory_reservations
      WHERE tenant_id = $1
        AND demand_type = 'work_order_component'
        AND demand_id = $2
      ORDER BY item_id ASC, location_id ASC, uom ASC, id ASC
      FOR UPDATE`,
    [tenantId, workOrderId]
  );
  return result.rows;
}

async function loadAvailabilityForLine(
  client: PoolClient,
  tenantId: string,
  line: WorkOrderReservationPlanLine
) {
  const result = await client.query<{ available_qty: string | number }>(
    `SELECT available_qty
       FROM inventory_available_location_v
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND location_id = $3
        AND item_id = $4
        AND uom = $5
      LIMIT 1`,
    [tenantId, line.warehouseId, line.locationId, line.componentItemId, line.uom]
  );
  return roundQuantity(toNumber(result.rows[0]?.available_qty ?? 0));
}

function reservationLineKey(line: {
  componentItemId: string;
  locationId: string;
  uom: string;
}) {
  return `${line.componentItemId}:${line.locationId}:${line.uom}`;
}

function reservationRowKey(row: ReservationRow) {
  return `${row.item_id}:${row.location_id}:${row.uom}`;
}

function logVoidReservationRestoreWarning(payload: Record<string, unknown>) {
  console.warn('WO_VOID_RESERVATION_RESTORE_WARNING', payload);
}

function assertReservationFulfillmentBounds(
  reservationId: string,
  quantityReserved: number,
  quantityFulfilled: number
) {
  if (quantityFulfilled < -1e-6 || quantityFulfilled - quantityReserved > 1e-6) {
    const error = new Error('WO_RESERVATION_CORRUPT') as Error & {
      code?: string;
      details?: Record<string, unknown>;
    };
    error.code = 'WO_RESERVATION_CORRUPT';
    error.details = {
      reservationId,
      quantityReserved,
      quantityFulfilled
    };
    throw error;
  }
}

function buildVoidReservationRestoreMetadata(executionId: string) {
  return {
    reservationRestore: 'void',
    executionId
  } as const;
}

async function hasVoidReservationRestoreMarker(
  client: PoolClient,
  tenantId: string,
  executionId: string
) {
  const result = await client.query(
    `SELECT 1
       FROM audit_log
      WHERE tenant_id = $1
        AND entity_type = 'work_order_execution'
        AND entity_id = $2
        AND action = 'update'
        AND COALESCE(metadata->>'reservationRestore', '') = 'void'
      LIMIT 1`,
    [tenantId, executionId]
  );
  return result.rowCount > 0;
}

function applyReservationState(row: ReservationRow, updated: ReservationStateRow) {
  row.status = updated.status;
  row.quantity_fulfilled = updated.quantity_fulfilled;
  row.updated_at = updated.updated_at;
  row.fulfilled_at = updated.fulfilled_at;
  row.released_at = updated.released_at;
  row.canceled_at = updated.canceled_at;
  row.release_reason_code = updated.release_reason_code;
  row.cancel_reason = updated.cancel_reason;
  row.allocated_at = updated.allocated_at;
}

export async function syncWorkOrderReservations(
  tenantId: string,
  workOrderId: string,
  client?: PoolClient
): Promise<WorkOrderReservationSnapshotLine[]> {
  if (!client) {
    return withTransaction((tx) => syncWorkOrderReservations(tenantId, workOrderId, tx));
  }

  const plan = await buildWorkOrderReservationPlan(tenantId, workOrderId, client);
  if (!plan) {
    throw new Error('WO_NOT_FOUND');
  }
  const now = new Date();
  const existingRows = await loadExistingReservations(client, tenantId, workOrderId);
  const existingByKey = new Map(existingRows.map((row) => [reservationRowKey(row), row]));
  const snapshot: WorkOrderReservationSnapshotLine[] = [];

  for (const planLine of plan.lines) {
    const existing = existingByKey.get(reservationLineKey(planLine));
    const fulfilledQty = roundQuantity(toNumber(existing?.quantity_fulfilled ?? 0));
    const existingOpenQty = roundQuantity(
      Math.max(0, toNumber(existing?.quantity_reserved ?? 0) - fulfilledQty)
    );
    const availableQty = await loadAvailabilityForLine(client, tenantId, planLine);
    const effectiveAvailable = roundQuantity(availableQty + existingOpenQty);
    const targetOpenReservedQty = roundQuantity(Math.min(planLine.requiredQty, effectiveAvailable));
    const nextQuantityReserved = roundQuantity(fulfilledQty + targetOpenReservedQty);

    let reservationId: string | null = existing?.id ?? null;
    let reservationStatus: string | null = existing?.status ?? null;
    if (existing) {
      if (nextQuantityReserved <= fulfilledQty) {
        const updatedReservation = await client.query<{ status: string }>(
          `UPDATE inventory_reservations
              SET quantity_reserved = $1,
                  quantity_fulfilled = $2,
                  status = CASE WHEN $2 <= 0 THEN 'CANCELLED' ELSE status END,
                  released_at = CASE WHEN $2 <= 0 THEN $3 ELSE NULL END,
                  canceled_at = CASE WHEN $2 <= 0 THEN $3 ELSE NULL END,
                  fulfilled_at = CASE
                    WHEN $2 > 0 AND $1 = $2 THEN COALESCE(fulfilled_at, $3)
                    ELSE NULL
                  END,
                  release_reason_code = CASE
                    WHEN $2 <= 0 THEN 'work_order_reservation_sync'
                    ELSE NULL
                  END,
                  updated_at = $3
            WHERE id = $4
              AND tenant_id = $5
        RETURNING status`,
          [fulfilledQty, fulfilledQty, now, existing.id, tenantId]
        );
        reservationStatus = updatedReservation.rows[0]?.status ?? reservationStatus;
      } else {
        const updatedReservation = await client.query<{ status: string }>(
          `UPDATE inventory_reservations
              SET quantity_reserved = $1,
                  updated_at = $2,
                  released_at = NULL,
                  canceled_at = NULL,
                  release_reason_code = NULL
            WHERE id = $3
              AND tenant_id = $4
        RETURNING status`,
          [nextQuantityReserved, now, existing.id, tenantId]
        );
        reservationStatus = updatedReservation.rows[0]?.status ?? reservationStatus;
      }
    } else if (nextQuantityReserved > 0) {
      reservationId = uuidv4();
      const insertedReservation = await client.query<{ status: string }>(
        `INSERT INTO inventory_reservations (
            id,
            tenant_id,
            client_id,
            status,
            demand_type,
            demand_id,
            item_id,
            location_id,
            warehouse_id,
            uom,
            quantity_reserved,
            quantity_fulfilled,
            reserved_at,
            notes,
            created_at,
            updated_at
         ) VALUES ($1,$2,$3,'RESERVED','work_order_component',$4,$5,$6,$7,$8,$9,0,$10,$11,$10,$10)
      RETURNING status`,
        [
          reservationId,
          tenantId,
          tenantId,
          workOrderId,
          planLine.componentItemId,
          planLine.locationId,
          planLine.warehouseId,
          planLine.uom,
          nextQuantityReserved,
          now,
          `Auto-reserved for work order ${workOrderId}`
        ]
      );
      reservationStatus = insertedReservation.rows[0]?.status ?? 'RESERVED';
    }

    snapshot.push({
      ...planLine,
      reservationId,
      reservationStatus,
      reservedQty: roundQuantity(nextQuantityReserved),
      fulfilledQty,
      openReservedQty: roundQuantity(Math.max(0, nextQuantityReserved - fulfilledQty)),
      availableQty: effectiveAvailable,
      shortageQty: roundQuantity(Math.max(0, planLine.requiredQty - targetOpenReservedQty))
    });
  }

  const activeKeys = new Set(plan.lines.map((line) => reservationLineKey(line)));
  for (const row of existingRows) {
    if (activeKeys.has(reservationRowKey(row))) {
      continue;
    }
    const fulfilledQty = roundQuantity(toNumber(row.quantity_fulfilled ?? 0));
    const reservedQty = roundQuantity(toNumber(row.quantity_reserved ?? 0));
    const openQty = roundQuantity(Math.max(0, reservedQty - fulfilledQty));
    if (openQty <= 0) {
      await client.query(
        `UPDATE inventory_reservations
            SET status = 'FULFILLED',
                fulfilled_at = COALESCE(fulfilled_at, $1),
                updated_at = $1
          WHERE id = $2
            AND tenant_id = $3`,
        [now, row.id, tenantId]
      );
      continue;
    }
    await client.query(
      `UPDATE inventory_reservations
          SET status = 'CANCELLED',
              released_at = $1,
              canceled_at = $1,
              release_reason_code = 'work_order_reservation_sync',
              updated_at = $1
        WHERE id = $2
          AND tenant_id = $3`,
      [now, row.id, tenantId]
    );
  }

  return snapshot;
}

export async function getWorkOrderReservationSnapshot(
  tenantId: string,
  workOrderId: string,
  client?: PoolClient
): Promise<WorkOrderReservationSnapshotLine[]> {
  const executor = client ? client.query.bind(client) : query;
  const plan = await buildWorkOrderReservationPlan(tenantId, workOrderId, client);
  if (!plan) {
    return [];
  }

  const reservationRows = await executor<
    ReservationRow & {
      location_code: string | null;
      location_name: string | null;
      location_role: string | null;
      item_sku: string | null;
      item_name: string | null;
    }
  >(
    `SELECT r.id,
            r.status,
            r.item_id,
            r.location_id,
            r.warehouse_id,
            r.uom,
            r.quantity_reserved,
            r.quantity_fulfilled,
            r.reserved_at,
            r.updated_at,
            l.code AS location_code,
            l.name AS location_name,
            l.role AS location_role,
            i.sku AS item_sku,
            i.name AS item_name
       FROM inventory_reservations r
       JOIN locations l
         ON l.id = r.location_id
        AND l.tenant_id = r.tenant_id
       JOIN items i
         ON i.id = r.item_id
        AND i.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1
        AND r.demand_type = 'work_order_component'
        AND r.demand_id = $2`,
    [tenantId, workOrderId]
  );
  const reservationsByKey = new Map(reservationRows.rows.map((row) => [reservationRowKey(row), row]));

  return Promise.all(
    plan.lines.map(async (planLine) => {
      const reservation = reservationsByKey.get(reservationLineKey(planLine));
      const fulfilledQty = roundQuantity(toNumber(reservation?.quantity_fulfilled ?? 0));
      const reservedQty = roundQuantity(toNumber(reservation?.quantity_reserved ?? 0));
      const openReservedQty = roundQuantity(Math.max(0, reservedQty - fulfilledQty));
      const rawAvailable = await loadAvailabilityForLine(
        client ?? ({ query: executor } as unknown as PoolClient),
        tenantId,
        planLine
      );
      const effectiveAvailable = roundQuantity(rawAvailable + openReservedQty);
      return {
        ...planLine,
        componentItemSku: reservation?.item_sku ?? planLine.componentItemSku,
        componentItemName: reservation?.item_name ?? planLine.componentItemName,
        locationCode: reservation?.location_code ?? planLine.locationCode,
        locationName: reservation?.location_name ?? planLine.locationName,
        locationRole: reservation?.location_role ?? planLine.locationRole,
        reservationId: reservation?.id ?? null,
        reservationStatus: reservation?.status ?? null,
        reservedQty,
        fulfilledQty,
        openReservedQty,
        availableQty: effectiveAvailable,
        shortageQty: roundQuantity(Math.max(0, planLine.requiredQty - openReservedQty))
      };
    })
  );
}

export async function ensureWorkOrderReservationsReady(
  tenantId: string,
  workOrderId: string,
  client?: PoolClient
): Promise<WorkOrderReservationSnapshotLine[]> {
  if (!client) {
    return withTransaction((tx) => ensureWorkOrderReservationsReady(tenantId, workOrderId, tx));
  }
  const snapshot = await syncWorkOrderReservations(tenantId, workOrderId, client);
  const shortages = snapshot.filter((line) => line.shortageQty > 0);
  if (shortages.length > 0) {
    const error = new Error('WO_RESERVATION_SHORTAGE') as Error & {
      code?: string;
      details?: Record<string, unknown>;
    };
    error.code = 'WO_RESERVATION_SHORTAGE';
    error.details = {
      workOrderId,
      shortages: shortages.map((line) => ({
        componentItemId: line.componentItemId,
        locationId: line.locationId,
        uom: line.uom,
        required: line.requiredQty,
        reserved: line.openReservedQty,
        shortage: line.shortageQty
      }))
    };
    throw error;
  }
  return snapshot;
}

export async function consumeWorkOrderReservations(
  tenantId: string,
  workOrderId: string,
  lines: Array<{ componentItemId: string; locationId: string; uom: string; quantity: number }>,
  client?: PoolClient
): Promise<void> {
  if (!client) {
    return withTransaction((tx) => consumeWorkOrderReservations(tenantId, workOrderId, lines, tx));
  }
  const normalized = new Map<string, { componentItemId: string; locationId: string; uom: string; quantity: number }>();
  for (const line of lines) {
    const canonical = await convertToCanonical(tenantId, line.componentItemId, line.quantity, line.uom, client);
    const key = reservationLineKey({
      componentItemId: line.componentItemId,
      locationId: line.locationId,
      uom: canonical.canonicalUom
    });
    const existing = normalized.get(key);
    if (existing) {
      existing.quantity = roundQuantity(existing.quantity + canonical.quantity);
    } else {
      normalized.set(key, {
        componentItemId: line.componentItemId,
        locationId: line.locationId,
        uom: canonical.canonicalUom,
        quantity: roundQuantity(canonical.quantity)
      });
    }
  }

  const reservations = await loadExistingReservations(client, tenantId, workOrderId);
  const byKey = new Map(reservations.map((row) => [reservationRowKey(row), row]));
  const now = new Date();

  for (const line of normalized.values()) {
    const reservation = byKey.get(reservationLineKey(line));
    if (!reservation) {
      const error = new Error('WO_RESERVATION_MISSING') as Error & {
        code?: string;
        details?: Record<string, unknown>;
      };
      error.code = 'WO_RESERVATION_MISSING';
      error.details = {
        workOrderId,
        componentItemId: line.componentItemId,
        locationId: line.locationId,
        uom: line.uom
      };
      throw error;
    }
    const reservedQty = roundQuantity(toNumber(reservation.quantity_reserved));
    const fulfilledQty = roundQuantity(toNumber(reservation.quantity_fulfilled ?? 0));
    const openReservedQty = roundQuantity(Math.max(0, reservedQty - fulfilledQty));
    if (line.quantity - openReservedQty > 1e-6) {
      const error = new Error('WO_RESERVATION_SHORTAGE') as Error & {
        code?: string;
        details?: Record<string, unknown>;
      };
      error.code = 'WO_RESERVATION_SHORTAGE';
      error.details = {
        workOrderId,
        componentItemId: line.componentItemId,
        locationId: line.locationId,
        uom: line.uom,
        requested: line.quantity,
        reserved: openReservedQty
      };
      throw error;
    }
    const nextFulfilled = roundQuantity(fulfilledQty + line.quantity);
    await client.query(
      `UPDATE inventory_reservations
          SET quantity_fulfilled = $1,
              fulfilled_at = CASE
                WHEN $1 >= quantity_reserved THEN COALESCE(fulfilled_at, $2)
                ELSE NULL
              END,
              updated_at = $2
        WHERE id = $3
          AND tenant_id = $4`,
      [nextFulfilled, now, reservation.id, tenantId]
    );
  }
}

export async function restoreReservationsForVoid(
  tenantId: string,
  workOrderId: string,
  executionId: string,
  client?: PoolClient
): Promise<void> {
  if (!client) {
    return withTransaction((tx) => restoreReservationsForVoid(tenantId, workOrderId, executionId, tx));
  }

  if (await hasVoidReservationRestoreMarker(client, tenantId, executionId)) {
    return;
  }

  const executionResult = await client.query<{ consumption_movement_id: string | null }>(
    `SELECT consumption_movement_id
       FROM work_order_executions
      WHERE tenant_id = $1
        AND id = $2
        AND work_order_id = $3
      FOR UPDATE`,
    [tenantId, executionId, workOrderId]
  );
  if (executionResult.rowCount === 0) {
    throw new Error('WO_VOID_EXECUTION_NOT_FOUND');
  }
  const consumptionMovementId = executionResult.rows[0]?.consumption_movement_id;
  if (!consumptionMovementId) {
    throw new Error('WO_VOID_EXECUTION_MOVEMENTS_MISSING');
  }

  const restoreDemandResult = await client.query<{
    item_id: string;
    location_id: string;
    uom: string;
    quantity: string | number;
  }>(
    `SELECT item_id,
            location_id,
            COALESCE(canonical_uom, uom) AS uom,
            ABS(SUM(COALESCE(quantity_delta_canonical, quantity_delta)))::numeric AS quantity
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
        AND COALESCE(quantity_delta_canonical, quantity_delta) < 0
      GROUP BY item_id, location_id, COALESCE(canonical_uom, uom)
      ORDER BY item_id ASC, location_id ASC, COALESCE(canonical_uom, uom) ASC`,
    [tenantId, consumptionMovementId]
  );
  if (restoreDemandResult.rowCount === 0) {
    await recordAuditLog(
      {
        tenantId,
        actorType: 'system',
        actorId: null,
        action: 'update',
        entityType: 'work_order_execution',
        entityId: executionId,
        metadata: {
          ...buildVoidReservationRestoreMetadata(executionId),
          skipped: true,
          reason: 'no_consumption_lines'
        }
      },
      client
    );
    return;
  }

  const reservations = await loadExistingReservations(client, tenantId, workOrderId);
  const reservationsByKey = new Map<string, ReservationRow[]>();
  for (const reservation of reservations) {
    const key = reservationRowKey(reservation);
    const existing = reservationsByKey.get(key);
    if (existing) {
      existing.push(reservation);
    } else {
      reservationsByKey.set(key, [reservation]);
    }
  }
  for (const rows of reservationsByKey.values()) {
    rows.sort((left, right) => {
      const fulfilledCompare =
        roundQuantity(toNumber(right.quantity_fulfilled ?? 0))
        - roundQuantity(toNumber(left.quantity_fulfilled ?? 0));
      if (Math.abs(fulfilledCompare) > 1e-6) {
        return fulfilledCompare > 0 ? 1 : -1;
      }
      return left.id.localeCompare(right.id);
    });
  }

  const now = new Date();
  for (const restoreLine of restoreDemandResult.rows) {
    const key = reservationLineKey({
      componentItemId: restoreLine.item_id,
      locationId: restoreLine.location_id,
      uom: restoreLine.uom
    });
    const matchingRows = reservationsByKey.get(key) ?? [];
    if (matchingRows.length === 0) {
      logVoidReservationRestoreWarning({
        tenantId,
        workOrderId,
        executionId,
        reason: 'reservation_row_missing',
        itemId: restoreLine.item_id,
        locationId: restoreLine.location_id,
        uom: restoreLine.uom,
        requestedRestoreQty: roundQuantity(toNumber(restoreLine.quantity))
      });
      continue;
    }

    let remainingToRestore = roundQuantity(toNumber(restoreLine.quantity));
    for (const row of matchingRows) {
      if (remainingToRestore <= 1e-6) {
        break;
      }
      const quantityReserved = roundQuantity(toNumber(row.quantity_reserved));
      const fulfilledQty = roundQuantity(toNumber(row.quantity_fulfilled ?? 0));
      if (fulfilledQty <= 1e-6) {
        continue;
      }
      if (row.status === 'CANCELLED' || row.status === 'EXPIRED') {
        logVoidReservationRestoreWarning({
          tenantId,
          workOrderId,
          executionId,
          reason: 'reservation_terminal_row_not_reopenable',
          reservationId: row.id,
          status: row.status,
          itemId: restoreLine.item_id,
          locationId: restoreLine.location_id,
          uom: restoreLine.uom,
          requestedRestoreQty: remainingToRestore
        });
        continue;
      }

      const restoredQty = roundQuantity(Math.min(remainingToRestore, fulfilledQty));
      const nextFulfilled = roundQuantity(fulfilledQty - restoredQty);
      assertReservationFulfillmentBounds(row.id, quantityReserved, nextFulfilled);

      if (Math.abs(restoredQty) <= 1e-6) {
        continue;
      }

      const updatedReservation = await client.query<ReservationStateRow>(
        `UPDATE inventory_reservations
            SET quantity_fulfilled = $1,
                updated_at = $2,
                fulfilled_at = CASE
                  WHEN $1 < quantity_reserved THEN NULL
                  ELSE fulfilled_at
                END
          WHERE id = $3
            AND tenant_id = $4
      RETURNING status,
                quantity_fulfilled,
                updated_at,
                fulfilled_at,
                released_at,
                canceled_at,
                release_reason_code,
                cancel_reason,
                allocated_at`,
        [nextFulfilled, now, row.id, tenantId]
      );
      const updatedRow = updatedReservation.rows[0];
      if (updatedRow) {
        applyReservationState(row, updatedRow);
      }
      remainingToRestore = roundQuantity(remainingToRestore - restoredQty);
    }

    if (remainingToRestore > 1e-6) {
      logVoidReservationRestoreWarning({
        tenantId,
        workOrderId,
        executionId,
        reason: 'reservation_fulfilled_shortfall',
        itemId: restoreLine.item_id,
        locationId: restoreLine.location_id,
        uom: restoreLine.uom,
        requestedRestoreQty: roundQuantity(toNumber(restoreLine.quantity)),
        restoredQty: roundQuantity(toNumber(restoreLine.quantity) - remainingToRestore),
        shortfallQty: remainingToRestore
      });
    }
  }

  await recordAuditLog(
    {
      tenantId,
      actorType: 'system',
      actorId: null,
      action: 'update',
      entityType: 'work_order_execution',
      entityId: executionId,
      metadata: buildVoidReservationRestoreMetadata(executionId)
    },
    client
  );
}

export async function releaseWorkOrderReservations(
  tenantId: string,
  workOrderId: string,
  reasonCode: string,
  client?: PoolClient
): Promise<void> {
  if (!client) {
    return withTransaction((tx) => releaseWorkOrderReservations(tenantId, workOrderId, reasonCode, tx));
  }
  const now = new Date();
  await client.query(
    `UPDATE inventory_reservations
        SET status = CASE
              WHEN GREATEST(0, quantity_reserved - COALESCE(quantity_fulfilled, 0)) <= 0 THEN 'FULFILLED'
              ELSE 'CANCELLED'
            END,
            released_at = CASE
              WHEN GREATEST(0, quantity_reserved - COALESCE(quantity_fulfilled, 0)) > 0 THEN $1
              ELSE released_at
            END,
            canceled_at = CASE
              WHEN GREATEST(0, quantity_reserved - COALESCE(quantity_fulfilled, 0)) > 0 THEN $1
              ELSE canceled_at
            END,
            fulfilled_at = CASE
              WHEN GREATEST(0, quantity_reserved - COALESCE(quantity_fulfilled, 0)) <= 0 THEN COALESCE(fulfilled_at, $1)
              ELSE fulfilled_at
            END,
            release_reason_code = CASE
              WHEN GREATEST(0, quantity_reserved - COALESCE(quantity_fulfilled, 0)) > 0 THEN $2
              ELSE release_reason_code
            END,
            updated_at = $1
      WHERE tenant_id = $3
        AND demand_type = 'work_order_component'
        AND demand_id = $4
        AND status IN ('RESERVED', 'ALLOCATED')`,
    [now, reasonCode, tenantId, workOrderId]
  );
}
