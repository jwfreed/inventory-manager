import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerProofFixture } from './helpers/ledgerProofFixture.mjs';

test('projection rebuild returns derived projections to exact pre-clear state', async () => {
  const { harness } = await createLedgerProofFixture('truth-projection-rebuild-equality');

  const before = await harness.snapshotDerivedProjections();
  assert.equal(before.inventoryBalance.length, 2);
  assert.equal(before.itemSummaries.length, 1);
  assert.deepEqual(before.itemSummaries, [
    {
      itemId: before.itemSummaries[0].itemId,
      quantityOnHand: 12,
      averageCost: 4.5
    }
  ]);

  await harness.clearDerivedProjections();

  const cleared = await harness.snapshotDerivedProjections();
  assert.notDeepEqual(cleared, before);
  assert.equal(cleared.inventoryBalance.length, 0);
  assert.deepEqual(cleared.itemSummaries, [
    {
      itemId: before.itemSummaries[0].itemId,
      quantityOnHand: 0,
      averageCost: null
    }
  ]);

  const rebuild = await harness.rebuildDerivedProjections();
  assert.equal(rebuild.balanceMismatches.length, before.inventoryBalance.length);
  assert.equal(rebuild.repairedBalanceCount, before.inventoryBalance.length);
  assert.equal(rebuild.quantityMismatches.length, before.itemSummaries.length);
  assert.equal(rebuild.repairedQuantityCount, before.itemSummaries.length);
  assert.equal(rebuild.valuationMismatches.length, before.itemSummaries.length);
  assert.equal(rebuild.repairedValuationCount, before.itemSummaries.length);

  const after = await harness.snapshotDerivedProjections();
  assert.deepEqual(after, before);
});
