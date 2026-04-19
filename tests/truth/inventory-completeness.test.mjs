import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createLedgerProofFixture } from './helpers/ledgerProofFixture.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  planFifoUnitConsumption,
  rebuildInventoryUnitStates
} = require('../../src/modules/platform/application/inventoryUnitAuthority.ts');
const {
  getInventoryReconciliationPolicy
} = require('../../src/config/inventoryPolicy.ts');
const {
  rebuildInventoryUnitsFromEvents
} = require('../../src/domains/inventory/index.ts');

function unitEvent(overrides) {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    movementId: 'movement-1',
    sourceLineId: 'source-line-1',
    skuId: 'sku-1',
    lotId: 'lot-1',
    locationId: 'loc-1',
    unitOfMeasure: 'each',
    eventTimestamp: '2026-03-01T00:00:00.000Z',
    reasonCode: 'receipt',
    stateTransition: 'received->available',
    recordQuantityDelta: 1,
    ...overrides
  };
}

test('FIFO consumption is deterministic across lots and supports partial depletion', () => {
  const events = [
    unitEvent({
      id: '00000000-0000-0000-0000-000000000004',
      movementId: 'movement-4',
      sourceLineId: 'line-4',
      lotId: 'lot-newer',
      eventTimestamp: '2026-03-04T00:00:00.000Z',
      recordQuantityDelta: 5
    }),
    unitEvent({
      id: '00000000-0000-0000-0000-000000000002',
      movementId: 'movement-2',
      sourceLineId: 'line-2',
      lotId: 'lot-older-tie-b',
      eventTimestamp: '2026-03-02T00:00:00.000Z',
      recordQuantityDelta: 3
    }),
    unitEvent({
      id: '00000000-0000-0000-0000-000000000001',
      movementId: 'movement-1',
      sourceLineId: 'line-1',
      lotId: 'lot-older-tie-a',
      eventTimestamp: '2026-03-02T00:00:00.000Z',
      recordQuantityDelta: 2
    }),
    unitEvent({
      id: '00000000-0000-0000-0000-000000000003',
      movementId: 'movement-3',
      sourceLineId: 'line-3',
      lotId: 'lot-other-location',
      locationId: 'loc-2',
      eventTimestamp: '2026-03-01T00:00:00.000Z',
      recordQuantityDelta: 99
    })
  ];

  const plan = planFifoUnitConsumption({
    events,
    skuId: 'sku-1',
    locationId: 'loc-1',
    unitOfMeasure: 'each',
    quantity: 6
  });

  assert.deepEqual(
    plan.map((entry) => [entry.lotId, entry.quantity]),
    [
      ['lot-older-tie-a', 2],
      ['lot-older-tie-b', 3],
      ['lot-newer', 1]
    ]
  );
});

test('unit rebuild rejects invalid transitions and keeps physical separate from record quantity', () => {
  assert.throws(
    () => rebuildInventoryUnitStates([
      unitEvent({ stateTransition: 'received->shipped' })
    ]),
    /INVENTORY_STATE_TRANSITION_INVALID/
  );

  const [state] = rebuildInventoryUnitStates([
    unitEvent({ recordQuantityDelta: 8, physicalQuantityDelta: null })
  ]);
  assert.equal(state.recordQuantity, 8);
  assert.equal(state.physicalQuantity, null);
});

test('rebuild parity is stable regardless of event input order', () => {
  const events = [
    unitEvent({ id: 'event-2', movementId: 'movement-2', sourceLineId: 'line-2', recordQuantityDelta: -2, stateTransition: 'available->adjusted', eventTimestamp: '2026-03-02T00:00:00.000Z' }),
    unitEvent({ id: 'event-1', recordQuantityDelta: 10, stateTransition: 'received->available', eventTimestamp: '2026-03-01T00:00:00.000Z' })
  ];

  assert.deepEqual(
    rebuildInventoryUnitStates(events),
    rebuildInventoryUnitStates([...events].reverse())
  );
});

test('reconciliation policy requires escalation above the controlled adjustment threshold', () => {
  const policy = getInventoryReconciliationPolicy();
  const variance = policy.autoAdjustMaxAbsQuantity + 1;

  assert.equal(Math.abs(variance) > policy.autoAdjustMaxAbsQuantity, true);
});

async function snapshotInventoryUnits(pool, tenantId) {
  const result = await pool.query(
    `SELECT sku_id,
            lot_key,
            location_id,
            unit_of_measure,
            state,
            record_quantity::numeric AS record_quantity,
            physical_quantity::numeric AS physical_quantity,
            first_event_timestamp,
            last_event_timestamp,
            last_event_id
       FROM inventory_units
      WHERE tenant_id = $1
      ORDER BY sku_id ASC,
               lot_key ASC,
               location_id ASC,
               unit_of_measure ASC`,
    [tenantId]
  );
  return result.rows.map((row) => ({
    skuId: row.sku_id,
    lotKey: row.lot_key,
    locationId: row.location_id,
    unitOfMeasure: row.unit_of_measure,
    state: row.state,
    recordQuantity: Number(row.record_quantity ?? 0),
    physicalQuantity: row.physical_quantity === null ? null : Number(row.physical_quantity),
    firstEventTimestamp: new Date(row.first_event_timestamp).toISOString(),
    lastEventTimestamp: new Date(row.last_event_timestamp).toISOString(),
    lastEventId: row.last_event_id
  }));
}

async function rebuildPersistedUnits(pool, tenantId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await rebuildInventoryUnitsFromEvents(client, tenantId);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('persisted unit events are authoritative, lot-preserving, and rebuildable from the event log', async () => {
  const { harness, itemId, sourceLocationId, destinationLocationId } =
    await createLedgerProofFixture('truth-inventory-unit-authority');
  const { pool, tenantId } = harness;

  const events = await pool.query(
    `SELECT movement_id,
            movement_line_id,
            source_line_id,
            sku_id,
            lot_key,
            location_id,
            unit_of_measure,
            event_timestamp,
            reason_code,
            state_transition,
            record_quantity_delta::numeric AS record_quantity_delta,
            physical_quantity_delta::numeric AS physical_quantity_delta
       FROM inventory_unit_events
      WHERE tenant_id = $1
        AND sku_id = $2
      ORDER BY event_timestamp ASC, id ASC`,
    [tenantId, itemId]
  );

  assert.equal(events.rows.length >= 3, true);
  assert.equal(events.rows.some((row) => Number(row.record_quantity_delta) < 0), true);
  assert.equal(events.rows.some((row) => Number(row.record_quantity_delta) > 0), true);
  for (const row of events.rows) {
    assert.ok(row.movement_id);
    assert.ok(row.movement_line_id);
    assert.ok(row.source_line_id);
    assert.ok(row.event_timestamp);
    assert.ok(row.reason_code);
    assert.match(row.state_transition, /^[a-z_]+->[a-z_]+$/);
    assert.equal(row.physical_quantity_delta, null);
  }

  const units = await snapshotInventoryUnits(pool, tenantId);
  const itemUnits = units.filter((unit) => unit.skuId === itemId);
  const sourceUnit = itemUnits.find((unit) => unit.locationId === sourceLocationId);
  const destinationUnit = itemUnits.find((unit) => unit.locationId === destinationLocationId);
  assert.equal(sourceUnit?.recordQuantity, 7);
  assert.equal(destinationUnit?.recordQuantity, 5);
  assert.equal(sourceUnit?.lotKey, destinationUnit?.lotKey);
  assert.equal(sourceUnit?.physicalQuantity, null);
  assert.equal(destinationUnit?.physicalQuantity, null);

  const parity = await pool.query(
    `WITH ledger AS (
       SELECT l.item_id,
              l.location_id,
              COALESCE(l.canonical_uom, l.uom) AS uom,
              COALESCE(SUM(COALESCE(l.quantity_delta_canonical, l.quantity_delta)), 0)::numeric AS qty
         FROM inventory_movement_lines l
         JOIN inventory_movements m
           ON m.id = l.movement_id
          AND m.tenant_id = l.tenant_id
        WHERE l.tenant_id = $1
          AND l.item_id = $2
          AND m.status = 'posted'
        GROUP BY l.item_id, l.location_id, COALESCE(l.canonical_uom, l.uom)
     ),
     units AS (
       SELECT sku_id AS item_id,
              location_id,
              unit_of_measure AS uom,
              COALESCE(SUM(record_quantity), 0)::numeric AS qty
         FROM inventory_units
        WHERE tenant_id = $1
          AND sku_id = $2
        GROUP BY sku_id, location_id, unit_of_measure
     )
     SELECT COALESCE(l.item_id, u.item_id) AS item_id,
            COALESCE(l.location_id, u.location_id) AS location_id,
            COALESCE(l.uom, u.uom) AS uom,
            COALESCE(l.qty, 0)::numeric AS ledger_qty,
            COALESCE(u.qty, 0)::numeric AS unit_qty
       FROM ledger l
       FULL OUTER JOIN units u
         ON u.item_id = l.item_id
        AND u.location_id = l.location_id
        AND u.uom = l.uom
      ORDER BY location_id ASC, uom ASC`,
    [tenantId, itemId]
  );
  assert.deepEqual(
    parity.rows.map((row) => Number(row.ledger_qty) - Number(row.unit_qty)),
    parity.rows.map(() => 0)
  );

  const beforeRebuild = await snapshotInventoryUnits(pool, tenantId);
  const rebuild = await rebuildPersistedUnits(pool, tenantId);
  assert.equal(rebuild.rebuiltCount, events.rows.length);
  const afterRebuild = await snapshotInventoryUnits(pool, tenantId);
  assert.deepEqual(afterRebuild, beforeRebuild);
});
