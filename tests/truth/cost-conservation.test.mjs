import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLedgerProofFixture } from './helpers/ledgerProofFixture.mjs';

test('cost conservation reports the exact valuation drift after cost-layer tampering', async () => {
  const { harness, itemId, sourceLocationId } = await createLedgerProofFixture('truth-cost-conservation');
  const { pool: db, tenantId } = harness;

  const cleanMismatches = await harness.findCostLayerConsistencyMismatches();
  assert.equal(cleanMismatches.length, 0);
  assert.deepEqual(cleanMismatches, []);

  // BREAK INVARIANT: add an extra cost layer that is not reflected in the derived item valuation.
  // EXPECT: cost conservation must report valuation drift for the affected item.
  await db.query(
    `INSERT INTO inventory_cost_layers (
        id,
        tenant_id,
        item_id,
        location_id,
        uom,
        layer_date,
        layer_sequence,
        original_quantity,
        remaining_quantity,
        unit_cost,
        extended_cost,
        source_type,
        source_document_id,
        movement_id,
        lot_id,
        notes,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, 'each', '2026-03-02T00:00:00.000Z', 999, 1, 1, 99, 99, 'opening_balance', $5, NULL, NULL, 'tampered truth layer', '2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z'
      )`,
    [randomUUID(), tenantId, itemId, sourceLocationId, randomUUID()]
  );

  const mismatches = await harness.findCostLayerConsistencyMismatches();
  assert.equal(mismatches.length, 1);
  const mismatch = mismatches[0];
  assert.equal(mismatch.itemId, itemId);
  assert.equal(mismatch.delta, 99);
  assert.equal(mismatch.layerValue - mismatch.summaryValue, mismatch.delta);
  assert.equal(mismatch.layerValue > mismatch.summaryValue, true);
});
