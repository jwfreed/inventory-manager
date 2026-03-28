import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';

test('simultaneous transfers on the same source location stay serialized and preserve invariants', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-concurrent-transfer',
    tenantName: 'Truth Concurrent Transfer'
  });
  const { topology } = harness;
  const storeA = await harness.createWarehouseWithSellable('TRUTH-A');
  const storeB = await harness.createWarehouseWithSellable('TRUTH-B');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'TRUTH-XFER',
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
        destinationLocationId: storeA.sellable.id,
        itemId: item.id,
        quantity: 6,
        uom: 'each',
        reasonCode: 'truth_a',
        notes: 'Truth concurrent transfer A',
        idempotencyKey: `truth-transfer-a-${randomUUID()}`
      });
    },
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: storeB.sellable.id,
        itemId: item.id,
        quantity: 6,
        uom: 'each',
        reasonCode: 'truth_b',
        notes: 'Truth concurrent transfer B',
        idempotencyKey: `truth-transfer-b-${randomUUID()}`
      });
    }
  ]);

  const fulfilled = outcomes.filter((entry) => entry.status === 'fulfilled');
  const rejected = outcomes.filter((entry) => entry.status === 'rejected');
  const sourceOnHand = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);
  const storeAOnHand = await harness.readOnHand(item.id, storeA.sellable.id);
  const storeBOnHand = await harness.readOnHand(item.id, storeB.sellable.id);
  const destinationTotal = storeAOnHand + storeBOnHand;

  assert.ok(fulfilled.length <= 1);
  assert.equal(fulfilled.length + rejected.length, outcomes.length);
  assert.equal(sourceOnHand + destinationTotal, 10);
  assert.ok(sourceOnHand === 10 || sourceOnHand === 4);
  assert.ok(destinationTotal === 0 || destinationTotal === 6);
  assert.ok(storeAOnHand === 0 || storeAOnHand === 6);
  assert.ok(storeBOnHand === 0 || storeBOnHand === 6);
  assert.ok((storeAOnHand === 6) !== (storeBOnHand === 6) || destinationTotal === 0);
  if (fulfilled.length === 1) {
    assert.equal(rejected.length, 1);
    assert.equal(sourceOnHand, 4);
    assert.equal(destinationTotal, 6);
  } else {
    assert.equal(rejected.length, 2);
    assert.equal(sourceOnHand, 10);
    assert.equal(destinationTotal, 0);
  }
  await harness.runStrictInvariants();
});
