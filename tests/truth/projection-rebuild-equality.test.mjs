import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerProofFixture } from './helpers/ledgerProofFixture.mjs';

test('projection rebuild returns derived projections to exact pre-clear state', async () => {
  const { harness } = await createLedgerProofFixture('truth-projection-rebuild-equality');

  const before = await harness.snapshotDerivedProjections();
  assert.equal(before.inventoryBalance.length > 0, true);
  assert.equal(before.itemSummaries.length > 0, true);

  // BREAK INVARIANT: erase derived projections so they no longer reflect the ledger.
  // EXPECT: rebuilding from the ledger must restore the exact pre-clear snapshot.
  await harness.clearDerivedProjections();

  const cleared = await harness.snapshotDerivedProjections();
  assert.notDeepEqual(cleared, before);
  assert.equal(cleared.inventoryBalance.length, 0);
  assert.equal(cleared.itemSummaries.length, before.itemSummaries.length);
  for (const row of cleared.itemSummaries) {
    assert.equal(row.quantityOnHand, 0);
    assert.equal(row.averageCost, null);
  }

  const visiblePhaseSnapshots = [];
  const rebuild = await harness.rebuildDerivedProjections({
    onPhaseApplied: async (phase) => {
      visiblePhaseSnapshots.push({
        phase,
        state: await harness.snapshotDerivedProjections()
      });
    }
  });
  assert.equal(rebuild.balanceMismatches.length > 0, true);
  assert.equal(rebuild.repairedBalanceCount, rebuild.balanceMismatches.length);
  assert.equal(rebuild.quantityMismatches.length > 0, true);
  assert.equal(rebuild.repairedQuantityCount, rebuild.quantityMismatches.length);
  assert.equal(rebuild.valuationMismatches.length > 0, true);
  assert.equal(rebuild.repairedValuationCount, rebuild.valuationMismatches.length);

  assert.deepEqual(
    visiblePhaseSnapshots.map((entry) => entry.phase),
    ['balances', 'quantities', 'valuations']
  );
  for (const observation of visiblePhaseSnapshots) {
    assert.deepEqual(
      observation.state,
      cleared,
      `externally visible projections must stay fully cleared during ${observation.phase}`
    );
  }

  const after = await harness.snapshotDerivedProjections();
  assert.deepEqual(after, before);
});
