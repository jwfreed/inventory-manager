import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// R-1, I-1: Idempotent replay produces no new rows
// ─────────────────────────────────────────────────────────────────────────────

test('transfer replay with same idempotency key returns same movement with no additional writes', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xfer-replay',
    tenantName: 'Truth Transfer Replay'
  });
  const { topology, tenantId, pool: db } = harness;
  const dest = await harness.createWarehouseWithSellable('XFER-RPL-DST');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XFER-RPL',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  const idempotencyKey = `truth-replay:${randomUUID()}`;
  const transferInput = {
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: dest.sellable.id,
    itemId: item.id,
    quantity: 4,
    uom: 'each',
    reasonCode: 'truth_replay',
    notes: 'Transfer for replay test',
    idempotencyKey
  };

  // First execution
  const first = await harness.postTransfer(transferInput);
  assert.equal(first.created, true);

  // Count writes after first execution
  const countAfterFirst = await countTransferWrites(db, tenantId, first.movementId, idempotencyKey);

  // Replay with same idempotency key
  const replay = await harness.postTransfer(transferInput);
  assert.equal(replay.movementId, first.movementId, 'replay returns same movementId');
  assert.equal(replay.replayed, true, 'replay flag set');

  // No new writes
  const countAfterReplay = await countTransferWrites(db, tenantId, first.movementId, idempotencyKey);
  assert.deepEqual(countAfterFirst, countAfterReplay, 'no new rows after replay');

  // Balances unchanged
  assert.equal(await harness.readOnHand(item.id, topology.defaults.SELLABLE.id), 6);
  assert.equal(await harness.readOnHand(item.id, dest.sellable.id), 4);

  await harness.runStrictInvariants();
});

// ─────────────────────────────────────────────────────────────────────────────
// R-2: Deterministic hash stability across replay
// ─────────────────────────────────────────────────────────────────────────────

test('transfer deterministic hash is stable and replay does not alter it', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xfer-hash',
    tenantName: 'Truth Transfer Hash'
  });
  const { topology, tenantId, pool: db } = harness;
  const dest = await harness.createWarehouseWithSellable('XFER-HSH-DST');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XFER-HSH',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  const idempotencyKey = `truth-hash:${randomUUID()}`;
  const transferInput = {
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: dest.sellable.id,
    itemId: item.id,
    quantity: 4,
    uom: 'each',
    reasonCode: 'truth_hash',
    idempotencyKey
  };

  const first = await harness.postTransfer(transferInput);
  const hashBefore = await readMovementHash(db, tenantId, first.movementId);
  assert.match(hashBefore, /^[a-f0-9]{64}$/);

  // Replay
  await harness.postTransfer(transferInput);
  const hashAfter = await readMovementHash(db, tenantId, first.movementId);
  assert.equal(hashAfter, hashBefore, 'hash unchanged after replay');

  // Audit confirms no integrity failures
  const audit = await harness.auditReplayDeterminism(10);
  assert.equal(audit.movementAudit.replayIntegrityFailures.count, 0);
  assert.equal(audit.eventRegistryFailures.count, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// R-3, P-1: Projection rebuild from ledger matches live state
// ─────────────────────────────────────────────────────────────────────────────

test('projection rebuild from ledger produces identical state after multiple transfers', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xfer-rebuild',
    tenantName: 'Truth Transfer Rebuild'
  });
  const { topology } = harness;
  const destA = await harness.createWarehouseWithSellable('XFER-RBD-A');
  const destB = await harness.createWarehouseWithSellable('XFER-RBD-B');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XFER-RBD',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 20,
    unitCost: 5
  });

  // Execute multiple transfers to create ledger history
  await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: destA.sellable.id,
    itemId: item.id,
    quantity: 7,
    uom: 'each',
    reasonCode: 'truth_rebuild_1',
    idempotencyKey: `truth-rbd1:${randomUUID()}`
  });
  await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: destB.sellable.id,
    itemId: item.id,
    quantity: 5,
    uom: 'each',
    reasonCode: 'truth_rebuild_2',
    idempotencyKey: `truth-rbd2:${randomUUID()}`
  });
  await harness.postTransfer({
    sourceLocationId: destA.sellable.id,
    destinationLocationId: destB.sellable.id,
    itemId: item.id,
    quantity: 3,
    uom: 'each',
    reasonCode: 'truth_rebuild_3',
    idempotencyKey: `truth-rbd3:${randomUUID()}`
  });

  // Snapshot live state
  const liveBefore = await harness.snapshotDerivedProjections();

  // Clear and rebuild
  await harness.clearDerivedProjections();
  await harness.rebuildDerivedProjections();

  // Snapshot rebuilt state
  const rebuilt = await harness.snapshotDerivedProjections();

  // Rebuilt projections must match live state
  assert.deepEqual(rebuilt, liveBefore, 'rebuilt projections match live state');

  // Quantity conservation: ledger sum == projected balance
  const mismatches = await harness.findQuantityConservationMismatches();
  assert.equal(mismatches.length, 0, 'no quantity conservation mismatches');

  // Verify expected balances
  // Source: 20 - 7 - 5 = 8
  // DestA: 7 - 3 = 4
  // DestB: 5 + 3 = 8
  assert.equal(await harness.readOnHand(item.id, topology.defaults.SELLABLE.id), 8);
  assert.equal(await harness.readOnHand(item.id, destA.sellable.id), 4);
  assert.equal(await harness.readOnHand(item.id, destB.sellable.id), 8);

  await harness.runStrictInvariants();
});

// ─────────────────────────────────────────────────────────────────────────────
// R-4, CL-4: Cost conservation after transfers verified from ledger
// ─────────────────────────────────────────────────────────────────────────────

test('cost layer consistency is maintained after transfers with no mismatches', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xfer-costcon',
    tenantName: 'Truth Transfer Cost Conservation'
  });
  const { topology, tenantId, pool: db } = harness;
  const dest = await harness.createWarehouseWithSellable('XFER-CCN-DST');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XFER-CCN',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  // Transfer and void to exercise full cost cycle
  const transfer = await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: dest.sellable.id,
    itemId: item.id,
    quantity: 4,
    uom: 'each',
    reasonCode: 'truth_costcon',
    idempotencyKey: `truth-ccn:${randomUUID()}`
  });

  // Active cost layers at both locations should sum correctly
  const activeLayers = await db.query(
    `SELECT COALESCE(SUM(remaining_quantity), 0)::numeric AS total_qty,
            COALESCE(SUM(
              CASE WHEN remaining_quantity > 0 THEN unit_cost * remaining_quantity ELSE 0 END
            ), 0)::numeric AS total_cost
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND item_id = $2
        AND voided_at IS NULL`,
    [tenantId, item.id]
  );
  assert.equal(Number(activeLayers.rows[0].total_qty), 10, 'total active quantity = seed');
  assert.equal(Number(activeLayers.rows[0].total_cost), 50, 'total active cost = 10 × $5');

  // Cost layer consistency check
  const costMismatches = await harness.findCostLayerConsistencyMismatches();
  assert.equal(costMismatches.length, 0, 'no cost layer consistency mismatches');

  await harness.runStrictInvariants();
});

// ─────────────────────────────────────────────────────────────────────────────
// R-5: All transfer movements have deterministic hashes
// ─────────────────────────────────────────────────────────────────────────────

test('all transfer movements have non-null deterministic hashes after operations', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xfer-hashall',
    tenantName: 'Truth Transfer Hash All'
  });
  const { topology, tenantId, pool: db } = harness;
  const dest = await harness.createWarehouseWithSellable('XFER-HA-DST');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XFER-HA',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  // Create transfer + void to generate multiple movements
  const transfer = await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: dest.sellable.id,
    itemId: item.id,
    quantity: 4,
    uom: 'each',
    reasonCode: 'truth_hashall',
    idempotencyKey: `truth-ha:${randomUUID()}`
  });

  await harness.voidTransfer(transfer.movementId, {
    reason: 'truth hash audit',
    actor: { type: 'system' },
    idempotencyKey: `truth-ha-void:${randomUUID()}`
  });

  // Every transfer movement should have a hash
  const unhashed = await db.query(
    `SELECT id, movement_type
       FROM inventory_movements
      WHERE tenant_id = $1
        AND movement_type = 'transfer'
        AND movement_deterministic_hash IS NULL`,
    [tenantId]
  );
  assert.equal(unhashed.rowCount, 0, 'no transfer movements missing hash');

  const audit = await harness.auditReplayDeterminism(25);
  assert.equal(audit.movementAudit.rowsMissingDeterministicHash, 0);
  assert.equal(audit.movementAudit.replayIntegrityFailures.count, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function countTransferWrites(db, tenantId, movementId, idempotencyKey) {
  const result = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM inventory_movements WHERE tenant_id = $1 AND id = $2) AS movements,
       (SELECT COUNT(*)::int FROM inventory_movement_lines WHERE tenant_id = $1 AND movement_id = $2) AS lines,
       (SELECT COUNT(*)::int FROM inventory_unit_events WHERE tenant_id = $1 AND movement_id = $2) AS unit_events,
       (SELECT COUNT(*)::int FROM inventory_events WHERE tenant_id = $1 AND producer_idempotency_key = $3) AS events,
       (SELECT COUNT(*)::int FROM idempotency_keys WHERE tenant_id = $1 AND key = $3) AS idempotency_rows`,
    [tenantId, movementId, idempotencyKey]
  );
  return {
    movements: Number(result.rows[0].movements),
    lines: Number(result.rows[0].lines),
    unitEvents: Number(result.rows[0].unit_events),
    events: Number(result.rows[0].events),
    idempotencyRows: Number(result.rows[0].idempotency_rows)
  };
}

async function readMovementHash(db, tenantId, movementId) {
  const result = await db.query(
    `SELECT movement_deterministic_hash
       FROM inventory_movements
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, movementId]
  );
  return result.rows[0]?.movement_deterministic_hash ?? null;
}
