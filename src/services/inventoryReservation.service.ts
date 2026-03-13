import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
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
  status: string;
  item_id: string;
  location_id: string;
  warehouse_id: string;
  uom: string;
  quantity_reserved: string | number;
  quantity_fulfilled: string | number | null;
  reserved_at: string;
  updated_at: string;
};

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
            status,
            item_id,
            location_id,
            warehouse_id,
            uom,
            quantity_reserved,
            quantity_fulfilled,
            reserved_at,
            updated_at
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
        reservationStatus = fulfilledQty > 0 ? 'FULFILLED' : 'CANCELLED';
        await client.query(
          `UPDATE inventory_reservations
              SET status = $1,
                  quantity_reserved = $2,
                  quantity_fulfilled = $3,
                  released_at = CASE WHEN $1 = 'CANCELLED' THEN $4 ELSE released_at END,
                  canceled_at = CASE WHEN $1 = 'CANCELLED' THEN $4 ELSE canceled_at END,
                  fulfilled_at = CASE WHEN $1 = 'FULFILLED' THEN COALESCE(fulfilled_at, $4) ELSE fulfilled_at END,
                  release_reason_code = CASE WHEN $1 = 'CANCELLED' THEN 'work_order_reservation_sync' ELSE release_reason_code END,
                  updated_at = $4
            WHERE id = $5
              AND tenant_id = $6`,
          [reservationStatus, fulfilledQty, fulfilledQty, now, existing.id, tenantId]
        );
      } else {
        reservationStatus = existing.status === 'ALLOCATED' ? 'ALLOCATED' : 'RESERVED';
        await client.query(
          `UPDATE inventory_reservations
              SET status = $1,
                  quantity_reserved = $2,
                  updated_at = $3,
                  released_at = NULL,
                  canceled_at = NULL,
                  release_reason_code = NULL
            WHERE id = $4
              AND tenant_id = $5`,
          [reservationStatus, nextQuantityReserved, now, existing.id, tenantId]
        );
      }
    } else if (nextQuantityReserved > 0) {
      reservationId = uuidv4();
      reservationStatus = 'RESERVED';
      await client.query(
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
         ) VALUES ($1,$2,$3,'RESERVED','work_order_component',$4,$5,$6,$7,$8,$9,0,$10,$11,$10,$10)`,
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
    const nextOpen = roundQuantity(Math.max(0, reservedQty - nextFulfilled));
    if (reservation.status === 'RESERVED') {
      await client.query(
        `UPDATE inventory_reservations
            SET quantity_fulfilled = $1,
                status = 'ALLOCATED',
                updated_at = $2
          WHERE id = $3
            AND tenant_id = $4`,
        [nextFulfilled, now, reservation.id, tenantId]
      );
      if (nextOpen <= 0) {
        await client.query(
          `UPDATE inventory_reservations
              SET status = 'FULFILLED',
                  fulfilled_at = COALESCE(fulfilled_at, $1),
                  updated_at = $1
            WHERE id = $2
              AND tenant_id = $3`,
          [now, reservation.id, tenantId]
        );
      }
      continue;
    }

    const nextStatus = nextOpen <= 0 ? 'FULFILLED' : 'ALLOCATED';
    await client.query(
      `UPDATE inventory_reservations
          SET quantity_fulfilled = $1,
              status = $2,
              fulfilled_at = CASE WHEN $2 = 'FULFILLED' THEN COALESCE(fulfilled_at, $3) ELSE fulfilled_at END,
              updated_at = $3
        WHERE id = $4
          AND tenant_id = $5`,
      [nextFulfilled, nextStatus, now, reservation.id, tenantId]
    );
  }
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
