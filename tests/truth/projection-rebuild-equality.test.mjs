import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerProofFixture } from './helpers/ledgerProofFixture.mjs';

test('projection rebuild reproduces derived projections exactly after clearing them', async () => {
  const { harness } = await createLedgerProofFixture('truth-projection-rebuild');

  const before = await harness.snapshotDerivedProjections();
  assert.ok(before.inventoryBalance.length > 0);

  await harness.clearDerivedProjections();
  const cleared = await harness.snapshotDerivedProjections();
  assert.deepEqual(cleared.inventoryBalance, []);

  const rebuild = await harness.rebuildDerivedProjections();
  assert.ok(rebuild.repairedBalanceCount > 0);
  assert.ok(rebuild.repairedQuantityCount > 0);
  assert.ok(rebuild.repairedValuationCount > 0);

  const after = await harness.snapshotDerivedProjections();
  assert.deepEqual(after, before);
});
