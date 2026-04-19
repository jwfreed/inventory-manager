import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { roundQuantity, toNumber } from '../../../lib/numbers';
import {
  assertInventoryStateTransition,
  deriveInventoryBalanceStateTransition,
  type InventoryState,
  type InventoryStateTransition
} from '../../../modules/platform/application/inventoryMovementLineSemantics';

const EPSILON = 1e-6;

type MovementLineUnitRow = {
  movement_id: string;
  movement_type: string;
  movement_lot_id: string | null;
  line_id: string;
  source_line_id: string;
  sku_id: string;
  location_id: string;
  unit_of_measure: string;
  event_timestamp: Date | string;
  recorded_at: Date | string | null;
  reason_code: string;
  record_quantity_delta: string | number;
};

type InventoryUnitRow = {
  id: string;
  tenant_id: string;
  sku_id: string;
  lot_id: string | null;
  lot_key: string;
  location_id: string;
  unit_of_measure: string;
  state: InventoryState;
  record_quantity: string | number;
  physical_quantity: string | number | null;
  first_event_timestamp: Date | string;
  last_event_timestamp: Date | string;
  last_event_id: string;
};

type InventoryUnitEventRow = {
  id: string;
  tenant_id: string;
  inventory_unit_id: string;
  movement_id: string;
  movement_line_id: string;
  source_line_id: string;
  sku_id: string;
  lot_id: string | null;
  lot_key: string;
  location_id: string;
  unit_of_measure: string;
  event_timestamp: Date | string;
  recorded_at: Date | string;
  reason_code: string;
  state_transition: InventoryStateTransition;
  record_quantity_delta: string | number;
  physical_quantity_delta: string | number | null;
};

type FifoUnitConsumption = {
  unit: InventoryUnitRow;
  quantity: number;
};

function deterministicUuid(parts: ReadonlyArray<string | null | undefined>): string {
  const hash = createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\u001f'))
    .digest('hex')
    .slice(0, 32);
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20)
  ].join('-');
}

function splitTransition(transition: InventoryStateTransition): [InventoryState, InventoryState] {
  return transition.split('->') as [InventoryState, InventoryState];
}

function resolveLotKey(params: {
  movementLotId: string | null;
  sourceLineId: string;
}): string {
  return params.movementLotId ?? `source:${params.sourceLineId}`;
}

function resolveUnitId(params: {
  tenantId: string;
  skuId: string;
  lotKey: string;
  locationId: string;
  unitOfMeasure: string;
}): string {
  return deterministicUuid([
    params.tenantId,
    params.skuId,
    params.lotKey,
    params.locationId,
    params.unitOfMeasure
  ]);
}

function resolveUnitEventId(params: {
  movementLineId: string;
  inventoryUnitId: string;
}): string {
  return deterministicUuid([
    params.movementLineId,
    params.inventoryUnitId
  ]);
}

function normalizeQuantity(value: unknown): number {
  return roundQuantity(toNumber(value));
}

function resolveStateTransition(params: {
  delta: number;
  reasonCode: string;
}): InventoryStateTransition {
  return deriveInventoryBalanceStateTransition({
    deltaOnHand: params.delta,
    reasonCode: params.reasonCode
  });
}

async function lockUnitById(
  client: PoolClient,
  tenantId: string,
  inventoryUnitId: string
): Promise<InventoryUnitRow | null> {
  const result = await client.query<InventoryUnitRow>(
    `SELECT *
       FROM inventory_units
      WHERE tenant_id = $1
        AND id = $2
      FOR UPDATE`,
    [tenantId, inventoryUnitId]
  );
  return result.rows[0] ?? null;
}

async function insertUnitEvent(
  client: PoolClient,
  event: InventoryUnitEventRow
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO inventory_unit_events (
        id,
        tenant_id,
        inventory_unit_id,
        movement_id,
        movement_line_id,
        source_line_id,
        sku_id,
        lot_id,
        lot_key,
        location_id,
        unit_of_measure,
        event_timestamp,
        recorded_at,
        reason_code,
        state_transition,
        record_quantity_delta,
        physical_quantity_delta,
        created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
     ON CONFLICT (tenant_id, movement_line_id, inventory_unit_id) DO NOTHING`,
    [
      event.id,
      event.tenant_id,
      event.inventory_unit_id,
      event.movement_id,
      event.movement_line_id,
      event.source_line_id,
      event.sku_id,
      event.lot_id,
      event.lot_key,
      event.location_id,
      event.unit_of_measure,
      event.event_timestamp,
      event.recorded_at,
      event.reason_code,
      event.state_transition,
      event.record_quantity_delta,
      event.physical_quantity_delta
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

async function upsertPositiveUnit(
  client: PoolClient,
  params: {
    tenantId: string;
    inventoryUnitId: string;
    skuId: string;
    lotId: string | null;
    lotKey: string;
    locationId: string;
    unitOfMeasure: string;
    stateTransition: InventoryStateTransition;
    quantity: number;
    eventTimestamp: Date | string;
    eventId: string;
  }
) {
  const [, toState] = splitTransition(params.stateTransition);
  await client.query(
    `INSERT INTO inventory_units (
        id,
        tenant_id,
        sku_id,
        lot_id,
        lot_key,
        location_id,
        unit_of_measure,
        state,
        record_quantity,
        physical_quantity,
        first_event_timestamp,
        last_event_timestamp,
        last_event_id,
        created_at,
        updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$10,$11,now(),now())
     ON CONFLICT (tenant_id, sku_id, lot_key, location_id, unit_of_measure) DO NOTHING`,
    [
      params.inventoryUnitId,
      params.tenantId,
      params.skuId,
      params.lotId,
      params.lotKey,
      params.locationId,
      params.unitOfMeasure,
      toState,
      params.quantity,
      params.eventTimestamp,
      params.eventId
    ]
  );

  const current = await lockUnitById(client, params.tenantId, params.inventoryUnitId);
  if (!current) {
    throw new Error('INVENTORY_UNIT_PROJECTION_MISSING');
  }
  if (current.last_event_id === params.eventId) {
    return;
  }

  const nextRecordQuantity = roundQuantity(normalizeQuantity(current.record_quantity) + params.quantity);
  await client.query(
    `UPDATE inventory_units
        SET state = $1,
            record_quantity = $2,
            last_event_timestamp = $3,
            last_event_id = $4,
            updated_at = now()
      WHERE tenant_id = $5
        AND id = $6`,
    [
      toState,
      nextRecordQuantity,
      params.eventTimestamp,
      params.eventId,
      params.tenantId,
      params.inventoryUnitId
    ]
  );
}

async function applyUnitEventToProjection(
  client: PoolClient,
  event: InventoryUnitEventRow
): Promise<void> {
  const recordDelta = normalizeQuantity(event.record_quantity_delta);
  if (recordDelta > EPSILON) {
    await upsertPositiveUnit(client, {
      tenantId: event.tenant_id,
      inventoryUnitId: event.inventory_unit_id,
      skuId: event.sku_id,
      lotId: event.lot_id,
      lotKey: event.lot_key,
      locationId: event.location_id,
      unitOfMeasure: event.unit_of_measure,
      stateTransition: event.state_transition,
      quantity: recordDelta,
      eventTimestamp: event.event_timestamp,
      eventId: event.id
    });
    return;
  }

  const current = await lockUnitById(client, event.tenant_id, event.inventory_unit_id);
  if (!current) {
    throw new Error('INVENTORY_UNIT_CONSUMPTION_TARGET_MISSING');
  }
  const [fromState, toState] = splitTransition(event.state_transition);
  const nextRecordQuantity = roundQuantity(normalizeQuantity(current.record_quantity) + recordDelta);
  if (nextRecordQuantity < -EPSILON) {
    throw new Error('INVENTORY_UNIT_RECORD_QUANTITY_NEGATIVE');
  }
  const nextState = nextRecordQuantity > EPSILON ? fromState : toState;
  await client.query(
    `UPDATE inventory_units
        SET state = $1,
            record_quantity = $2,
            last_event_timestamp = $3,
            last_event_id = $4,
            updated_at = now()
      WHERE tenant_id = $5
        AND id = $6`,
    [
      nextState,
      Math.max(0, nextRecordQuantity),
      event.event_timestamp,
      event.id,
      event.tenant_id,
      event.inventory_unit_id
    ]
  );
}

async function appendAndApplyUnitEvent(
  client: PoolClient,
  event: InventoryUnitEventRow
) {
  const [fromState, toState] = splitTransition(event.state_transition);
  assertInventoryStateTransition(fromState, toState);
  const inserted = await insertUnitEvent(client, event);
  if (!inserted) return;
  await applyUnitEventToProjection(client, event);
}

async function loadMovementUnitLines(
  client: PoolClient,
  tenantId: string,
  movementId: string
): Promise<MovementLineUnitRow[]> {
  const result = await client.query<MovementLineUnitRow>(
    `SELECT m.id AS movement_id,
            m.movement_type,
            m.lot_id AS movement_lot_id,
            l.id AS line_id,
            l.source_line_id,
            l.item_id AS sku_id,
            l.location_id,
            COALESCE(l.canonical_uom, l.uom) AS unit_of_measure,
            COALESCE(l.event_timestamp, l.created_at) AS event_timestamp,
            l.recorded_at,
            l.reason_code,
            COALESCE(l.quantity_delta_canonical, l.quantity_delta) AS record_quantity_delta
       FROM inventory_movement_lines l
       JOIN inventory_movements m
         ON m.id = l.movement_id
        AND m.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1
        AND l.movement_id = $2
        AND m.status = 'posted'
      ORDER BY COALESCE(l.event_timestamp, l.created_at) ASC, l.id ASC`,
    [tenantId, movementId]
  );
  return result.rows;
}

async function appendPositiveUnitEvent(
  client: PoolClient,
  params: {
    tenantId: string;
    line: MovementLineUnitRow;
    quantity: number;
    stateTransition: InventoryStateTransition;
    lotKey: string;
    lotId?: string | null;
  }
) {
  const unitId = resolveUnitId({
    tenantId: params.tenantId,
    skuId: params.line.sku_id,
    lotKey: params.lotKey,
    locationId: params.line.location_id,
    unitOfMeasure: params.line.unit_of_measure
  });
  const eventId = resolveUnitEventId({
    movementLineId: params.line.line_id,
    inventoryUnitId: unitId
  });
  await appendAndApplyUnitEvent(client, {
    id: eventId,
    tenant_id: params.tenantId,
    inventory_unit_id: unitId,
    movement_id: params.line.movement_id,
    movement_line_id: params.line.line_id,
    source_line_id: params.line.source_line_id,
    sku_id: params.line.sku_id,
    lot_id: params.lotId ?? params.line.movement_lot_id,
    lot_key: params.lotKey,
    location_id: params.line.location_id,
    unit_of_measure: params.line.unit_of_measure,
    event_timestamp: params.line.event_timestamp,
    recorded_at: params.line.recorded_at ?? params.line.event_timestamp,
    reason_code: params.line.reason_code,
    state_transition: params.stateTransition,
    record_quantity_delta: params.quantity,
    physical_quantity_delta: null
  });
}

async function lockAvailableUnitsForFifo(
  client: PoolClient,
  params: {
    tenantId: string;
    skuId: string;
    locationId: string;
    unitOfMeasure: string;
  }
): Promise<InventoryUnitRow[]> {
  const result = await client.query<InventoryUnitRow>(
    `SELECT *
       FROM inventory_units
      WHERE tenant_id = $1
        AND sku_id = $2
        AND location_id = $3
        AND unit_of_measure = $4
        AND state = 'available'
        AND record_quantity > 0
      ORDER BY first_event_timestamp ASC, id ASC
      FOR UPDATE`,
    [params.tenantId, params.skuId, params.locationId, params.unitOfMeasure]
  );
  return result.rows;
}

async function appendNegativeUnitEventsFifo(
  client: PoolClient,
  params: {
    tenantId: string;
    line: MovementLineUnitRow;
    quantity: number;
    stateTransition: InventoryStateTransition;
  }
): Promise<FifoUnitConsumption[]> {
  let remaining = roundQuantity(Math.abs(params.quantity));
  const units = await lockAvailableUnitsForFifo(client, {
    tenantId: params.tenantId,
    skuId: params.line.sku_id,
    locationId: params.line.location_id,
    unitOfMeasure: params.line.unit_of_measure
  });
  const consumption: FifoUnitConsumption[] = [];

  for (const unit of units) {
    if (remaining <= EPSILON) break;
    const available = normalizeQuantity(unit.record_quantity);
    if (available <= EPSILON) continue;
    const consumed = roundQuantity(Math.min(available, remaining));
    const eventId = resolveUnitEventId({
      movementLineId: params.line.line_id,
      inventoryUnitId: unit.id
    });
    await appendAndApplyUnitEvent(client, {
      id: eventId,
      tenant_id: params.tenantId,
      inventory_unit_id: unit.id,
      movement_id: params.line.movement_id,
      movement_line_id: params.line.line_id,
      source_line_id: params.line.source_line_id,
      sku_id: params.line.sku_id,
      lot_id: unit.lot_id,
      lot_key: unit.lot_key,
      location_id: params.line.location_id,
      unit_of_measure: params.line.unit_of_measure,
      event_timestamp: params.line.event_timestamp,
      recorded_at: params.line.recorded_at ?? params.line.event_timestamp,
      reason_code: params.line.reason_code,
      state_transition: params.stateTransition,
      record_quantity_delta: -consumed,
      physical_quantity_delta: null
    });
    consumption.push({ unit, quantity: consumed });
    remaining = roundQuantity(remaining - consumed);
  }

  if (remaining > EPSILON) {
    throw new Error('INVENTORY_UNIT_INSUFFICIENT_AVAILABLE');
  }
  return consumption;
}

function unitQueueKey(line: Pick<MovementLineUnitRow, 'sku_id' | 'unit_of_measure'>): string {
  return [line.sku_id, line.unit_of_measure].join('\u001f');
}

async function applyTransferMovementToInventoryUnits(
  client: PoolClient,
  params: {
    tenantId: string;
    lines: MovementLineUnitRow[];
  }
): Promise<void> {
  const consumptionBySkuUom = new Map<string, FifoUnitConsumption[]>();

  for (const line of params.lines) {
    const delta = normalizeQuantity(line.record_quantity_delta);
    if (delta >= -EPSILON) continue;
    const stateTransition = resolveStateTransition({
      delta,
      reasonCode: line.reason_code
    });
    const consumption = await appendNegativeUnitEventsFifo(client, {
      tenantId: params.tenantId,
      line,
      quantity: delta,
      stateTransition
    });
    const key = unitQueueKey(line);
    consumptionBySkuUom.set(key, [
      ...(consumptionBySkuUom.get(key) ?? []),
      ...consumption
    ]);
  }

  for (const line of params.lines) {
    const delta = normalizeQuantity(line.record_quantity_delta);
    if (delta <= EPSILON) continue;
    const stateTransition = resolveStateTransition({
      delta,
      reasonCode: line.reason_code
    });
    const consumption = consumptionBySkuUom.get(unitQueueKey(line)) ?? [];
    let remaining = delta;

    while (remaining > EPSILON) {
      const source = consumption[0];
      if (!source) {
        throw new Error('INVENTORY_UNIT_TRANSFER_LOT_CHAIN_MISSING');
      }
      const quantity = roundQuantity(Math.min(source.quantity, remaining));
      await appendPositiveUnitEvent(client, {
        tenantId: params.tenantId,
        line,
        quantity,
        stateTransition,
        lotKey: source.unit.lot_key,
        lotId: source.unit.lot_id
      });
      source.quantity = roundQuantity(source.quantity - quantity);
      remaining = roundQuantity(remaining - quantity);
      if (source.quantity <= EPSILON) {
        consumption.shift();
      }
    }
  }

  for (const remainingConsumption of consumptionBySkuUom.values()) {
    if (remainingConsumption.some((entry) => entry.quantity > EPSILON)) {
      throw new Error('INVENTORY_UNIT_TRANSFER_QUANTITY_IMBALANCE');
    }
  }
}

export async function applyPersistedMovementToInventoryUnits(
  client: PoolClient,
  params: {
    tenantId: string;
    movementId: string;
  }
): Promise<void> {
  const lines = await loadMovementUnitLines(client, params.tenantId, params.movementId);
  for (const line of lines) {
    if (!line.source_line_id?.trim()) {
      throw new Error('INVENTORY_UNIT_EVENT_SOURCE_LINE_ID_REQUIRED');
    }
    if (!line.reason_code?.trim()) {
      throw new Error('INVENTORY_UNIT_EVENT_REASON_CODE_REQUIRED');
    }
  }

  if (lines.some((line) => line.movement_type === 'transfer')) {
    await applyTransferMovementToInventoryUnits(client, {
      tenantId: params.tenantId,
      lines
    });
    return;
  }

  for (const line of lines) {
    const delta = normalizeQuantity(line.record_quantity_delta);
    const stateTransition = resolveStateTransition({
      delta,
      reasonCode: line.reason_code
    });
    if (delta > EPSILON) {
      await appendPositiveUnitEvent(client, {
        tenantId: params.tenantId,
        line,
        quantity: delta,
        stateTransition,
        lotKey: resolveLotKey({
          movementLotId: line.movement_lot_id,
          sourceLineId: line.source_line_id
        })
      });
      continue;
    }
    if (delta < -EPSILON) {
      await appendNegativeUnitEventsFifo(client, {
        tenantId: params.tenantId,
        line,
        quantity: delta,
        stateTransition
      });
    }
  }
}

export async function rebuildInventoryUnitsFromEvents(
  client: PoolClient,
  tenantId: string
): Promise<{ rebuiltCount: number }> {
  await client.query('DELETE FROM inventory_units WHERE tenant_id = $1', [tenantId]);
  const events = await client.query<InventoryUnitEventRow>(
    `SELECT *
       FROM inventory_unit_events
      WHERE tenant_id = $1
      ORDER BY event_timestamp ASC, id ASC`,
    [tenantId]
  );
  for (const event of events.rows) {
    await applyUnitEventToProjection(client, event);
  }
  return { rebuiltCount: events.rowCount ?? 0 };
}
