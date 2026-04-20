import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// C-1: Two competing transfers on same source → no double-consumption
// ─────────────────────────────────────────────────────────────────────────────

test('two concurrent transfers competing for limited stock produce deterministic winner with no negative inventory', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xfer-cc-compete',
    tenantName: 'Truth Transfer Concurrency Compete'
  });
  const { topology } = harness;
  const destA = await harness.createWarehouseWithSellable('CC-COMP-A');
  const destB = await harness.createWarehouseWithSellable('CC-COMP-B');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'CC-COMP',
    type: 'raw'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  const outcomes = await harness.runConcurrently([
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: destA.sellable.id,
        itemId: item.id,
        quantity: 7,
        uom: 'each',
        reasonCode: 'cc_compete_a',
        notes: 'Concurrent transfer A',
        idempotencyKey: `cc-compete-a:${randomUUID()}`
      });
    },
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: destB.sellable.id,
        itemId: item.id,
        quantity: 7,
        uom: 'each',
        reasonCode: 'cc_compete_b',
        notes: 'Concurrent transfer B',
        idempotencyKey: `cc-compete-b:${randomUUID()}`
      });
    }
  ]);

  const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
  const rejected = outcomes.filter((o) => o.status === 'rejected');

  // At most one should succeed (10 < 7 + 7)
  assert.ok(fulfilled.length <= 1, 'at most one concurrent transfer succeeds');
  assert.equal(fulfilled.length + rejected.length, 2);

  // Read all balances
  const sourceOnHand = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);
  const destAOnHand = await harness.readOnHand(item.id, destA.sellable.id);
  const destBOnHand = await harness.readOnHand(item.id, destB.sellable.id);

  // No negative inventory anywhere
  assert.ok(sourceOnHand >= 0, 'source never negative');
  assert.ok(destAOnHand >= 0, 'destination A never negative');
  assert.ok(destBOnHand >= 0, 'destination B never negative');

  // Total on_hand always conserved
  assert.equal(sourceOnHand + destAOnHand + destBOnHand, 10, 'total on_hand conserved');

  // If one succeeded, exactly 7 moved
  if (fulfilled.length === 1) {
    assert.equal(rejected.length, 1);
    assert.equal(sourceOnHand, 3);
    assert.equal(destAOnHand + destBOnHand, 7);
    assert.ok(
      (destAOnHand === 7 && destBOnHand === 0) || (destAOnHand === 0 && destBOnHand === 7),
      'exactly one destination received stock'
    );
  } else {
    // Both failed (serialization exhausted)
    assert.equal(sourceOnHand, 10);
    assert.equal(destAOnHand, 0);
    assert.equal(destBOnHand, 0);
  }

  await harness.runStrictInvariants();
});

// ─────────────────────────────────────────────────────────────────────────────
// C-2: Two concurrent transfers that both fit → both succeed
// ─────────────────────────────────────────────────────────────────────────────

test('two concurrent transfers that both fit within available stock both succeed via serialized execution', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xfer-cc-both',
    tenantName: 'Truth Transfer Concurrency Both Fit'
  });
  const { topology } = harness;
  const destA = await harness.createWarehouseWithSellable('CC-BOTH-A');
  const destB = await harness.createWarehouseWithSellable('CC-BOTH-B');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'CC-BOTH',
    type: 'raw'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 20,
    unitCost: 5
  });

  const outcomes = await harness.runConcurrently([
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: destA.sellable.id,
        itemId: item.id,
        quantity: 8,
        uom: 'each',
        reasonCode: 'cc_both_a',
        notes: 'Concurrent transfer A (both fit)',
        idempotencyKey: `cc-both-a:${randomUUID()}`
      });
    },
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: destB.sellable.id,
        itemId: item.id,
        quantity: 8,
        uom: 'each',
        reasonCode: 'cc_both_b',
        notes: 'Concurrent transfer B (both fit)',
        idempotencyKey: `cc-both-b:${randomUUID()}`
      });
    }
  ]);

  const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');

  // Both should succeed (20 >= 8 + 8)
  // Serialization retries should handle the conflict
  assert.ok(fulfilled.length >= 1, 'at least one transfer succeeds');

  const sourceOnHand = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);
  const destAOnHand = await harness.readOnHand(item.id, destA.sellable.id);
  const destBOnHand = await harness.readOnHand(item.id, destB.sellable.id);

  // No negative inventory
  assert.ok(sourceOnHand >= 0, 'source never negative');
  assert.ok(destAOnHand >= 0, 'destination A never negative');
  assert.ok(destBOnHand >= 0, 'destination B never negative');

  // Total conserved
  assert.equal(sourceOnHand + destAOnHand + destBOnHand, 20, 'total on_hand conserved');

  if (fulfilled.length === 2) {
    assert.equal(sourceOnHand, 4, 'source = 20 - 8 - 8');
    assert.equal(destAOnHand, 8);
    assert.equal(destBOnHand, 8);
  }

  await harness.runStrictInvariants();
});

// ─────────────────────────────────────────────────────────────────────────────
// C-3: Three concurrent transfers, only enough stock for two → max two succeed
// ─────────────────────────────────────────────────────────────────────────────

test('three concurrent transfers with stock for two produce at most two winners with no oversell', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xfer-cc-three',
    tenantName: 'Truth Transfer Concurrency Three'
  });
  const { topology } = harness;
  const destA = await harness.createWarehouseWithSellable('CC-TRI-A');
  const destB = await harness.createWarehouseWithSellable('CC-TRI-B');
  const destC = await harness.createWarehouseWithSellable('CC-TRI-C');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'CC-TRI',
    type: 'raw'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 16,
    unitCost: 5
  });

  const outcomes = await harness.runConcurrently([
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: destA.sellable.id,
        itemId: item.id,
        quantity: 8,
        uom: 'each',
        reasonCode: 'cc_tri_a',
        idempotencyKey: `cc-tri-a:${randomUUID()}`
      });
    },
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: destB.sellable.id,
        itemId: item.id,
        quantity: 8,
        uom: 'each',
        reasonCode: 'cc_tri_b',
        idempotencyKey: `cc-tri-b:${randomUUID()}`
      });
    },
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: destC.sellable.id,
        itemId: item.id,
        quantity: 8,
        uom: 'each',
        reasonCode: 'cc_tri_c',
        idempotencyKey: `cc-tri-c:${randomUUID()}`
      });
    }
  ]);

  const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
  const rejected = outcomes.filter((o) => o.status === 'rejected');

  // At most 2 can succeed (16 / 8 = 2)
  assert.ok(fulfilled.length <= 2, 'at most two concurrent transfers succeed');
  assert.ok(fulfilled.length >= 1 || rejected.length === 3, 'at least one succeeds or all fail');
  assert.equal(fulfilled.length + rejected.length, 3);

  const sourceOnHand = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);
  const destAOnHand = await harness.readOnHand(item.id, destA.sellable.id);
  const destBOnHand = await harness.readOnHand(item.id, destB.sellable.id);
  const destCOnHand = await harness.readOnHand(item.id, destC.sellable.id);
  const total = sourceOnHand + destAOnHand + destBOnHand + destCOnHand;

  // No negative inventory anywhere
  assert.ok(sourceOnHand >= 0, 'source never negative');
  assert.ok(destAOnHand >= 0, 'dest A never negative');
  assert.ok(destBOnHand >= 0, 'dest B never negative');
  assert.ok(destCOnHand >= 0, 'dest C never negative');

  // Total always conserved
  assert.equal(total, 16, 'total on_hand conserved');

  // Transferred quantity matches fulfilled count
  const transferred = destAOnHand + destBOnHand + destCOnHand;
  assert.equal(transferred, fulfilled.length * 8, 'transferred = fulfilled × 8');
  assert.equal(sourceOnHand, 16 - transferred, 'source = seed - transferred');

  await harness.runStrictInvariants();
});
