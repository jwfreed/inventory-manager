import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from './helpers/service-harness.mjs';

async function withEnv(overrides, action) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function assertNoDuplicateTransferCostArtifacts(db, tenantId, movementIds) {
  if (movementIds.length === 0) {
    return;
  }

  const [duplicateLinks, duplicateConsumptions] = await Promise.all([
    db.query(
      `SELECT transfer_movement_id,
              transfer_out_line_id,
              transfer_in_line_id,
              source_cost_layer_id,
              COUNT(*)::int AS duplicate_count
         FROM cost_layer_transfer_links
        WHERE tenant_id = $1
          AND transfer_movement_id = ANY($2::uuid[])
        GROUP BY transfer_movement_id, transfer_out_line_id, transfer_in_line_id, source_cost_layer_id
       HAVING COUNT(*) > 1`,
      [tenantId, movementIds]
    ),
    db.query(
      `SELECT movement_id,
              consumption_document_id,
              cost_layer_id,
              COUNT(*)::int AS duplicate_count
         FROM cost_layer_consumptions
        WHERE tenant_id = $1
          AND movement_id = ANY($2::uuid[])
        GROUP BY movement_id, consumption_document_id, cost_layer_id
       HAVING COUNT(*) > 1`,
      [tenantId, movementIds]
    )
  ]);

  assert.equal(duplicateLinks.rowCount, 0);
  assert.equal(duplicateConsumptions.rowCount, 0);
}

test('concurrent transfers preserve quantity and cost conservation under source contention', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'transfer-concurrency-hardening',
    tenantName: 'Transfer Concurrency Hardening'
  });
  const { topology, pool: db, tenantId } = harness;
  const stores = await Promise.all(
    Array.from({ length: 5 }, (_, index) => harness.createWarehouseWithSellable(`XFER-${index + 1}`))
  );
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XFER-LOCK',
    type: 'raw'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  const outcomes = await harness.runConcurrently(
    stores.map((store, index) => async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: store.sellable.id,
        itemId: item.id,
        quantity: 3,
        uom: 'each',
        reasonCode: `stress_${index + 1}`,
        notes: `Concurrent transfer ${index + 1}`,
        idempotencyKey: `transfer-stress-${index + 1}-${randomUUID()}`
      });
    })
  );

  const fulfilled = outcomes.filter((entry) => entry.status === 'fulfilled');
  const rejected = outcomes.filter((entry) => entry.status === 'rejected');
  const movementIds = fulfilled.map((entry) => entry.value.movementId);
  const movedQuantity = fulfilled.length * 3;
  const sourceOnHand = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);
  const destinationTotal = await Promise.all(
    stores.map((store) => harness.readOnHand(item.id, store.sellable.id))
  ).then((rows) => rows.reduce((sum, value) => sum + value, 0));

  assert.equal(fulfilled.length, 3);
  assert.equal(rejected.length, 2);
  assert.equal(sourceOnHand, 1);
  assert.equal(destinationTotal, movedQuantity);
  assert.equal(sourceOnHand + destinationTotal, 10);

  const linkedQuantity = await db.query(
    `SELECT COALESCE(SUM(quantity), 0)::numeric AS quantity
       FROM cost_layer_transfer_links
      WHERE tenant_id = $1
        AND transfer_movement_id = ANY($2::uuid[])`,
    [tenantId, movementIds]
  );
  assert.equal(Number(linkedQuantity.rows[0]?.quantity ?? 0), movedQuantity);
  await assertNoDuplicateTransferCostArtifacts(db, tenantId, movementIds);
  await harness.runStrictInvariants();
});

test('idempotent retry storms converge on one movement and one cost relocation set', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'transfer-retry-storm',
    tenantName: 'Transfer Retry Storm'
  });
  const { topology, pool: db, tenantId } = harness;
  const store = await harness.createWarehouseWithSellable('RETRY-STORM');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XFER-IDEM',
    type: 'raw'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 6,
    unitCost: 4
  });

  const idempotencyKey = `transfer-retry-storm-${randomUUID()}`;
  const outcomes = await harness.runConcurrently(
    Array.from({ length: 8 }, () => async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: store.sellable.id,
        itemId: item.id,
        quantity: 4,
        uom: 'each',
        reasonCode: 'retry_storm',
        notes: 'Retry storm transfer',
        idempotencyKey
      });
    })
  );

  const fulfilled = outcomes.filter((entry) => entry.status === 'fulfilled');
  const rejected = outcomes.filter((entry) => entry.status === 'rejected');
  for (const entry of rejected) {
    assert.equal(entry.reason?.code ?? entry.reason?.message, 'TX_RETRY_EXHAUSTED');
  }
  assert.ok(fulfilled.length >= 1);

  const movementIds = new Set(fulfilled.map((entry) => entry.value.movementId));
  const replayedFalseCount = fulfilled.filter((entry) => entry.value.replayed === false).length;
  assert.equal(movementIds.size, 1);
  assert.equal(replayedFalseCount, 1);
  assert.equal(await harness.countIdempotencyRows(idempotencyKey), 1);

  const authoritativeMovementId = [...movementIds][0];
  const movementCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, authoritativeMovementId]
  );
  assert.equal(Number(movementCount.rows[0]?.count ?? 0), 1);
  await assertNoDuplicateTransferCostArtifacts(db, tenantId, [authoritativeMovementId]);
  await harness.runStrictInvariants();
});

test('post-persist transfer costing failures roll back movement, links, and idempotency state', async () => {
  await withEnv(
    {
      ALLOW_NEGATIVE_INVENTORY: 'false',
      ALLOW_NEGATIVE_WITH_OVERRIDE: 'true',
      NEGATIVE_OVERRIDE_REQUIRES_REASON: 'true',
      NEGATIVE_OVERRIDE_REQUIRES_ROLE: 'false'
    },
    async () => {
      const harness = await createServiceHarness({
        tenantPrefix: 'transfer-rollback-hardening',
        tenantName: 'Transfer Rollback Hardening'
      });
      const { topology, pool: db, tenantId } = harness;
      const store = await harness.createWarehouseWithSellable('ROLLBACK');
      const item = await harness.createItem({
        defaultLocationId: topology.defaults.SELLABLE.id,
        skuPrefix: 'XFER-ROLLBACK',
        type: 'raw'
      });
      const idempotencyKey = `transfer-rollback-${randomUUID()}`;

      await assert.rejects(
        () =>
          harness.postTransfer({
            sourceLocationId: topology.defaults.SELLABLE.id,
            destinationLocationId: store.sellable.id,
            itemId: item.id,
            quantity: 2,
            uom: 'each',
            reasonCode: 'rollback_probe',
            notes: 'Rollback probe',
            overrideNegative: true,
            overrideReason: 'rollback-proof',
            idempotencyKey
          }),
        (error) => {
          assert.equal(error?.code ?? error?.message, 'TRANSFER_INSUFFICIENT_COST_LAYERS');
          return true;
        }
      );

      const [movementCount, lineCount, linkCount, idempotencyCount] = await Promise.all([
        db.query(
          `SELECT COUNT(*)::int AS count
             FROM inventory_movements
            WHERE tenant_id = $1
              AND source_type = 'inventory_transfer'
              AND source_id = $2`,
          [tenantId, `idempotency:${idempotencyKey}`]
        ),
        db.query(
          `SELECT COUNT(*)::int AS count
             FROM inventory_movement_lines ml
             JOIN inventory_movements m
               ON m.id = ml.movement_id
            WHERE ml.tenant_id = $1
              AND m.source_type = 'inventory_transfer'
              AND m.source_id = $2`,
          [tenantId, `idempotency:${idempotencyKey}`]
        ),
        db.query(
          `SELECT COUNT(*)::int AS count
             FROM cost_layer_transfer_links
            WHERE tenant_id = $1`,
          [tenantId]
        ),
        db.query(
          `SELECT COUNT(*)::int AS count
             FROM idempotency_keys
            WHERE tenant_id = $1
              AND key = $2`,
          [tenantId, idempotencyKey]
        )
      ]);

      assert.equal(Number(movementCount.rows[0]?.count ?? 0), 0);
      assert.equal(Number(lineCount.rows[0]?.count ?? 0), 0);
      assert.equal(Number(linkCount.rows[0]?.count ?? 0), 0);
      assert.equal(Number(idempotencyCount.rows[0]?.count ?? 0), 0);
      await harness.runStrictInvariants();
    }
  );
});
