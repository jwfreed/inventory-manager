import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerProofFixture } from './helpers/ledgerProofFixture.mjs';

test('quantity conservation detects projection drift for item-location balances', async () => {
  const { harness, itemId, sourceLocationId } = await createLedgerProofFixture('truth-quantity');
  const { pool: db, tenantId } = harness;

  const before = await harness.findQuantityConservationMismatches();
  assert.deepEqual(before, []);

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

  const after = await harness.findQuantityConservationMismatches();
  assert.ok(after.length > 0);
  assert.ok(after.some((row) => row.itemId === itemId && row.locationId === sourceLocationId));
});
