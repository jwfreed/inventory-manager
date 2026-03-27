import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerProofFixture } from './helpers/ledgerProofFixture.mjs';

test('quantity conservation reports the exact item-location drift after projection tampering', async () => {
  const { harness, itemId, sourceLocationId } = await createLedgerProofFixture('truth-quantity-conservation');
  const { pool: db, tenantId } = harness;

  const cleanMismatches = await harness.findQuantityConservationMismatches();
  assert.equal(cleanMismatches.length, 0);
  assert.deepEqual(cleanMismatches, []);

  // BREAK INVARIANT: drift the projected on-hand balance away from the ledger-derived quantity.
  // EXPECT: quantity conservation must report the affected item/location mismatch.
  await db.query(
    `UPDATE inventory_balance
        SET on_hand = on_hand + 3,
            updated_at = now()
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = 'each'`,
    [tenantId, itemId, sourceLocationId]
  );

  const mismatches = await harness.findQuantityConservationMismatches();
  assert.equal(mismatches.length, 1);
  const mismatch = mismatches[0];
  assert.equal(mismatch.itemId, itemId);
  assert.equal(mismatch.locationId, sourceLocationId);
  assert.equal(mismatch.uom, 'each');
  assert.equal(mismatch.delta, 3);
  assert.equal(mismatch.projectedOnHand - mismatch.authoritativeOnHand, mismatch.delta);
  assert.equal(mismatch.projectedOnHand > mismatch.authoritativeOnHand, true);
});
