import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from './helpers/service-harness.mjs';

async function createLedgerProofFixture(prefix) {
  const harness = await createServiceHarness({
    tenantPrefix: prefix,
    tenantName: `Ledger Proof ${prefix}`
  });
  const store = await harness.createWarehouseWithSellable(`STORE-${randomUUID().slice(0, 6)}`);
  const item = await harness.createItem({
    defaultLocationId: harness.topology.defaults.SELLABLE.id,
    skuPrefix: 'LEDGER-PROOF',
    type: 'raw'
  });

  await harness.seedStockViaCount({
    warehouseId: harness.topology.warehouse.id,
    itemId: item.id,
    locationId: harness.topology.defaults.SELLABLE.id,
    quantity: 12,
    unitCost: 4.5
  });

  await harness.postTransfer({
    sourceLocationId: harness.topology.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId: item.id,
    quantity: 5,
    uom: 'each',
    reasonCode: 'distribution',
    notes: 'Ledger proof transfer',
    idempotencyKey: `ledger-proof-transfer:${harness.tenantId}:${item.id}`
  });

  return {
    harness,
    itemId: item.id,
    sourceLocationId: harness.topology.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id
  };
}

test('projection rebuild reproduces derived projections exactly after clearing them', async () => {
  const { harness } = await createLedgerProofFixture('projection-rebuild');

  const before = await harness.snapshotDerivedProjections();
  assert.ok(before.inventoryBalance.length > 0, 'expected inventory_balance projection rows before rebuild');

  await harness.clearDerivedProjections();

  const afterClear = await harness.snapshotDerivedProjections();
  assert.deepEqual(afterClear.inventoryBalance, []);
  assert.ok(
    afterClear.itemSummaries.some((row) => row.quantityOnHand === 0 && row.averageCost === null),
    'expected item summary projections to be cleared'
  );

  const rebuild = await harness.rebuildDerivedProjections();
  assert.ok(rebuild.repairedBalanceCount > 0, 'expected balance projection rows to be rebuilt');
  assert.ok(rebuild.repairedQuantityCount > 0, 'expected item quantity summaries to be rebuilt');
  assert.ok(rebuild.repairedValuationCount > 0, 'expected item valuation summaries to be rebuilt');

  const after = await harness.snapshotDerivedProjections();
  assert.deepEqual(after, before);

  const strict = await harness.runStrictInvariants();
  assert.doesNotMatch(strict.stderr ?? '', /\[strict_failure_summary\]/);
});

test('ledger replay audit recomputes hashes and validates persisted event identity for every row', async () => {
  const { harness } = await createLedgerProofFixture('replay-audit');

  const audit = await harness.auditReplayDeterminism(10);
  assert.ok(audit.movementAudit.totalMovements > 0, 'expected authoritative movements to audit');
  assert.equal(audit.movementAudit.rowsMissingDeterministicHash, 0);
  assert.equal(audit.movementAudit.postCutoffRowsMissingHash, 0);
  assert.equal(audit.movementAudit.replayIntegrityFailures.count, 0);
  assert.equal(audit.eventRegistryFailures.count, 0);
});

test('quantity conservation detects projection drift for item-location balances', async () => {
  const { harness, itemId, sourceLocationId } = await createLedgerProofFixture('quantity-conservation');
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
  assert.ok(after.length > 0, 'expected quantity conservation mismatches after projection drift');
  assert.ok(
    after.some((row) => row.itemId === itemId && row.locationId === sourceLocationId && Math.abs(row.delta) > 0),
    'expected mismatched item/location row to be reported'
  );

  await db.query(
    `UPDATE inventory_balance
        SET on_hand = on_hand - 3,
            updated_at = now()
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = 'each'`,
    [tenantId, itemId, sourceLocationId]
  );
});

test('cost layer consistency detects valuation drift between layers and derived item valuation', async () => {
  const { harness, itemId, sourceLocationId } = await createLedgerProofFixture('cost-layer-consistency');
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
        $1, $2, $3, $4, 'each', now(), 999, 1, 1, 99, 99, 'opening_balance', $5, NULL, NULL, 'tampered cost layer', now(), now()
      )`,
    [randomUUID(), tenantId, itemId, sourceLocationId, randomUUID()]
  );

  const after = await harness.findCostLayerConsistencyMismatches();
  assert.ok(after.length > 0, 'expected valuation mismatches after tampering cost layers');
  assert.ok(
    after.some((row) => row.itemId === itemId && Math.abs(row.delta) > 0),
    'expected mismatched item valuation to be reported'
  );
});
