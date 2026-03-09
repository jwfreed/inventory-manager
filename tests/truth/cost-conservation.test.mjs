import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLedgerProofFixture } from './helpers/ledgerProofFixture.mjs';

test('cost layer consistency detects valuation drift between layers and derived item valuation', async () => {
  const { harness, itemId, sourceLocationId } = await createLedgerProofFixture('truth-cost');
  const { pool: db, tenantId } = harness;

  const before = await harness.findCostLayerConsistencyMismatches();
  assert.deepEqual(before, []);

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
        $1, $2, $3, $4, 'each', now(), 999, 1, 1, 99, 99, 'opening_balance', $5, NULL, NULL, 'tampered truth layer', now(), now()
      )`,
    [randomUUID(), tenantId, itemId, sourceLocationId, randomUUID()]
  );

  const after = await harness.findCostLayerConsistencyMismatches();
  assert.ok(after.length > 0);
  assert.ok(after.some((row) => row.itemId === itemId && Math.abs(row.delta) > 0));
});
