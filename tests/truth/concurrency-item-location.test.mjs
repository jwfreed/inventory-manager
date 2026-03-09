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
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(await harness.readOnHand(item.id, topology.defaults.SELLABLE.id), 4);
  assert.equal(
    (await harness.readOnHand(item.id, storeA.sellable.id))
      + (await harness.readOnHand(item.id, storeB.sellable.id)),
    6
  );
  await harness.runStrictInvariants();
});
