import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { insertPostedMovementFixture } from '../helpers/movementFixture.mjs';

const FIXED_OCCURRED_AT = '2026-03-02T00:00:00.000Z';
const CORRUPTED_HASH = '0'.repeat(64);

async function loadEvents(db, tenantId, filters = {}) {
  const clauses = ['tenant_id = $1'];
  const params = [tenantId];

  if (filters.aggregateType) {
    params.push(filters.aggregateType);
    clauses.push(`aggregate_type = $${params.length}`);
  }
  if (filters.aggregateId) {
    params.push(filters.aggregateId);
    clauses.push(`aggregate_id = $${params.length}`);
  }
  if (filters.aggregateTypes) {
    params.push(filters.aggregateTypes);
    clauses.push(`aggregate_type = ANY($${params.length})`);
  }
  if (filters.aggregateIds) {
    params.push(filters.aggregateIds);
    clauses.push(`aggregate_id = ANY($${params.length})`);
  }

  const result = await db.query(
    `SELECT event_seq,
            aggregate_type,
            aggregate_id,
            event_type,
            event_version,
            payload
       FROM inventory_events
      WHERE ${clauses.join(' AND ')}
      ORDER BY event_seq ASC`,
    params
  );
  return result.rows;
}

function assertStrictEventSeq(events) {
  for (let index = 1; index < events.length; index += 1) {
    const previous = BigInt(events[index - 1].event_seq);
    const current = BigInt(events[index].event_seq);
    assert.ok(current > previous, `event_seq must strictly increase: ${previous} -> ${current}`);
  }
}

function assertUniqueEventIdentity(events) {
  const identities = events.map(
    (event) =>
      `${event.aggregate_type}:${event.aggregate_id}:${event.event_type}:${event.event_version}`
  );
  assert.equal(new Set(identities).size, identities.length, 'inventory_events must not contain duplicates');
}

async function assertAggregateTargetsExist(db, tenantId, events) {
  for (const event of events) {
    if (event.aggregate_type === 'inventory_movement') {
      const result = await db.query(
        `SELECT 1
           FROM inventory_movements
          WHERE tenant_id = $1
            AND id = $2`,
        [tenantId, event.aggregate_id]
      );
      assert.equal(result.rowCount, 1, `missing movement aggregate target ${event.aggregate_id}`);
      continue;
    }

    if (event.aggregate_type === 'inventory_count') {
      const result = await db.query(
        `SELECT 1
           FROM cycle_counts
          WHERE tenant_id = $1
            AND id = $2`,
        [tenantId, event.aggregate_id]
      );
      assert.equal(result.rowCount, 1, `missing cycle_count aggregate target ${event.aggregate_id}`);
      continue;
    }

    if (event.aggregate_type === 'inventory_transfer') {
      const result = await db.query(
        `SELECT 1
           FROM inventory_movements
          WHERE tenant_id = $1
            AND id = $2
            AND source_type = 'inventory_transfer'`,
        [tenantId, event.aggregate_id]
      );
      assert.equal(result.rowCount, 1, `missing inventory_transfer aggregate target ${event.aggregate_id}`);
      continue;
    }

    assert.fail(`unsupported aggregate_type ${event.aggregate_type}`);
  }
}

test('movement hash integrity fails closed after safe authoritative hash corruption', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-movement-hash-integrity',
    tenantName: 'Truth Movement Hash Integrity'
  });
  const { tenantId, pool: db, topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'TRUTH-HASH',
    type: 'raw'
  });

  const movementId = randomUUID();
  await insertPostedMovementFixture(db, {
    id: movementId,
    tenantId,
    movementType: 'receive',
    sourceType: 'truth_hash_fixture',
    sourceId: randomUUID(),
    externalRef: 'truth-hash:fixture-1',
    occurredAt: FIXED_OCCURRED_AT,
    movementDeterministicHash: CORRUPTED_HASH,
    lines: [
      {
        itemId: item.id,
        locationId: topology.defaults.SELLABLE.id,
        quantityDelta: 5,
        uom: 'each',
        quantityDeltaEntered: 5,
        uomEntered: 'each',
        quantityDeltaCanonical: 5,
        canonicalUom: 'each',
        uomDimension: 'count',
        unitCost: 2,
        extendedCost: 10,
        reasonCode: 'truth_hash_fixture'
      }
    ]
  });

  const audit = await harness.auditReplayDeterminism(10);
  assert.equal(audit.movementAudit.totalMovements, 1);
  assert.equal(audit.movementAudit.rowsMissingDeterministicHash, 0);
  assert.equal(audit.movementAudit.postCutoffRowsMissingHash, 0);
  assert.equal(audit.movementAudit.replayIntegrityFailures.count, 1);
  assert.equal(audit.movementAudit.replayIntegrityFailures.sample.length, 1);
  assert.equal(audit.movementAudit.replayIntegrityFailures.sample[0].movementId, movementId);
  assert.equal(
    audit.movementAudit.replayIntegrityFailures.sample[0].reason,
    'authoritative_movement_hash_mismatch'
  );
  assert.equal(audit.eventRegistryFailures.count, 0);
});

test('cycle count event stream stays complete, unique, ordered, and non-orphaned', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-event-completeness',
    tenantName: 'Truth Event Completeness'
  });
  const { tenantId, pool: db, topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'TRUTH-EVENT-COUNT',
    type: 'raw'
  });

  const count = await harness.createInventoryCountDraft(
    {
      countedAt: '2026-03-03T00:00:00.000Z',
      warehouseId: topology.warehouse.id,
      locationId: topology.defaults.SELLABLE.id,
      lines: [
        {
          itemId: item.id,
          locationId: topology.defaults.SELLABLE.id,
          uom: 'each',
          countedQuantity: 4,
          unitCostForPositiveAdjustment: 7,
          reasonCode: 'truth_found_stock'
        }
      ]
    },
    {
      idempotencyKey: `truth-count-create:${randomUUID()}`
    }
  );

  const postedCount = await harness.postInventoryCount(
    count.id,
    `truth-count-post:${randomUUID()}`,
    {
      expectedWarehouseId: topology.warehouse.id,
      actor: { type: 'system', id: null }
    }
  );

  const events = await loadEvents(db, tenantId, {
    aggregateTypes: ['inventory_count', 'inventory_movement'],
    aggregateIds: [postedCount.id, postedCount.inventoryMovementId]
  });

  assert.equal(events.length, 2);
  assertStrictEventSeq(events);
  assertUniqueEventIdentity(events);
  await assertAggregateTargetsExist(db, tenantId, events);

  const eventTypes = new Set(events.map((event) => event.event_type));
  assert.deepEqual(
    eventTypes,
    new Set(['inventory.count.posted', 'inventory.movement.posted'])
  );

  const countEvent = events.find((event) => event.aggregate_type === 'inventory_count');
  const movementEvent = events.find((event) => event.aggregate_type === 'inventory_movement');
  assert.ok(countEvent);
  assert.ok(movementEvent);
  assert.equal(countEvent.payload?.countId, postedCount.id);
  assert.equal(countEvent.payload?.movementId, postedCount.inventoryMovementId);
  assert.equal(movementEvent.payload?.movementId, postedCount.inventoryMovementId);

  const audit = await harness.auditReplayDeterminism(10);
  assert.equal(audit.movementAudit.replayIntegrityFailures.count, 0);
  assert.equal(audit.eventRegistryFailures.count, 0);
});

test('transfer event stream preserves a valid causal chain for created, issued, and received', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-event-causality',
    tenantName: 'Truth Event Causality'
  });
  const { tenantId, pool: db, topology } = harness;

  const store = await harness.createWarehouseWithSellable('TRUTH-EVENT-STORE');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'TRUTH-EVENT-XFER',
    type: 'raw'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 9,
    unitCost: 3
  });

  const transfer = await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId: item.id,
    quantity: 4,
    uom: 'each',
    reasonCode: 'truth_transfer',
    notes: 'Truth transfer event stream',
    idempotencyKey: `truth-transfer-events:${randomUUID()}`
  });

  const transferEvents = await loadEvents(db, tenantId, {
    aggregateType: 'inventory_transfer',
    aggregateId: transfer.transferId
  });
  assert.equal(transferEvents.length, 3);
  assertStrictEventSeq(transferEvents);
  assertUniqueEventIdentity(transferEvents);
  await assertAggregateTargetsExist(db, tenantId, transferEvents);

  assert.deepEqual(
    transferEvents.map((event) => event.event_type),
    [
      'inventory.transfer.created',
      'inventory.transfer.issued',
      'inventory.transfer.received'
    ]
  );
  for (const event of transferEvents) {
    assert.equal(event.payload?.transferId, transfer.transferId);
    assert.equal(event.payload?.movementId, transfer.movementId);
  }

  const movementEvents = await loadEvents(db, tenantId, {
    aggregateType: 'inventory_movement',
    aggregateId: transfer.movementId
  });
  assert.equal(movementEvents.length, 1);
  assert.equal(movementEvents[0].event_type, 'inventory.movement.posted');
  assert.equal(movementEvents[0].payload?.movementId, transfer.movementId);
});
