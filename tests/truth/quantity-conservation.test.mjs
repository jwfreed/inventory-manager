import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerProofFixture } from './helpers/ledgerProofFixture.mjs';

test('quantity conservation reports the exact item-location drift after projection tampering', async () => {
  const { harness, itemId, sourceLocationId } = await createLedgerProofFixture('truth-quantity-conservation');
  const { pool: db, tenantId } = harness;

  const cleanMismatches = await harness.findQuantityConservationMismatches();
  assert.equal(cleanMismatches.length, 0);
  assert.deepEqual(cleanMismatches, []);

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
  assert.deepEqual(mismatches, [
    {
      itemId,
      locationId: sourceLocationId,
      uom: 'each',
      projectedOnHand: 10,
      authoritativeOnHand: 7,
      delta: 3
    }
  ]);
});
