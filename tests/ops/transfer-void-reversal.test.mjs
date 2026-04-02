import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServiceHarness } from './helpers/service-harness.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  prepareTransferReversalPolicy
} = require('../../src/domain/transfers/transferReversalPolicy.ts');
const {
  buildTransferReversalPlan
} = require('../../src/domain/transfers/transferReversalPlan.ts');

async function readMovementLines(db, tenantId, movementId) {
  const result = await db.query(
    `SELECT id,
            item_id,
            location_id,
            COALESCE(quantity_delta_canonical, quantity_delta)::numeric AS effective_quantity,
            extended_cost
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
      ORDER BY location_id ASC, id ASC`,
    [tenantId, movementId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    itemId: row.item_id,
    locationId: row.location_id,
    effectiveQuantity: Number(row.effective_quantity ?? 0),
    extendedCost: row.extended_cost === null ? null : Number(row.extended_cost)
  }));
}

async function readTransferLinks(db, tenantId, movementId) {
  const result = await db.query(
    `SELECT transfer_out_line_id,
            transfer_in_line_id,
            source_cost_layer_id,
            dest_cost_layer_id,
            quantity::numeric AS quantity,
            unit_cost::numeric AS unit_cost,
            extended_cost::numeric AS extended_cost
       FROM cost_layer_transfer_links
      WHERE tenant_id = $1
        AND transfer_movement_id = $2
      ORDER BY transfer_out_line_id ASC, transfer_in_line_id ASC, id ASC`,
    [tenantId, movementId]
  );
  return result.rows.map((row) => ({
    transferOutLineId: row.transfer_out_line_id,
    transferInLineId: row.transfer_in_line_id,
    sourceCostLayerId: row.source_cost_layer_id,
    destCostLayerId: row.dest_cost_layer_id,
    quantity: Number(row.quantity ?? 0),
    unitCost: Number(row.unit_cost ?? 0),
    extendedCost: Number(row.extended_cost ?? 0)
  }));
}

async function readLocationCostBuckets(db, tenantId, itemId, locationId) {
  const result = await db.query(
    `SELECT unit_cost::numeric AS unit_cost,
            COALESCE(SUM(remaining_quantity), 0)::numeric AS remaining_quantity,
            COALESCE(SUM(remaining_quantity * unit_cost), 0)::numeric AS remaining_value
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND voided_at IS NULL
      GROUP BY unit_cost
      ORDER BY unit_cost ASC`,
    [tenantId, itemId, locationId]
  );
  return result.rows.map((row) => ({
    unitCost: Number(row.unit_cost ?? 0),
    remainingQuantity: Number(row.remaining_quantity ?? 0),
    remainingValue: Number(row.remaining_value ?? 0)
  }));
}

async function readMovementHashAndOccurredAt(db, tenantId, movementId) {
  const result = await db.query(
    `SELECT movement_deterministic_hash, occurred_at
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, movementId]
  );
  assert.equal(result.rowCount, 1);
  return {
    deterministicHash: result.rows[0].movement_deterministic_hash,
    occurredAt: new Date(result.rows[0].occurred_at)
  };
}

async function createTransferFixture(harness, { quantity = 7 } = {}) {
  const { topology } = harness;
  const { tenantId, pool: db } = harness;
  const store = await harness.createWarehouseWithSellable(`REV-${randomUUID().slice(0, 6)}`);
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XFER-REV',
    type: 'raw'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 4,
    countedAt: '2026-01-01T00:00:00.000Z'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 7,
    countedAt: '2026-01-02T00:00:00.000Z'
  });

  const sourceBucketsBeforeTransfer = await readLocationCostBuckets(
    db,
    tenantId,
    item.id,
    topology.defaults.SELLABLE.id
  );
  const sourceInitialOnHand = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);
  const destinationInitialOnHand = await harness.readOnHand(item.id, store.sellable.id);

  const transfer = await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId: item.id,
    quantity,
    uom: 'each',
    reasonCode: 'transfer_reversal_test',
    notes: 'transfer reversal test',
    idempotencyKey: `transfer-reversal-${randomUUID()}`
  });

  return {
    store,
    item,
    transfer,
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    sourceInitialOnHand,
    destinationInitialOnHand,
    sourceBucketsBeforeTransfer
  };
}

test('transfer reversal restores projection balances to the exact pre-transfer state', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'transfer-reversal-balance',
    tenantName: 'Transfer Reversal Balance'
  });
  const fixture = await createTransferFixture(harness, { quantity: 4 });

  assert.equal(fixture.sourceInitialOnHand, 10);
  assert.equal(fixture.destinationInitialOnHand, 0);

  const sourceAfterTransfer = await harness.readOnHand(fixture.item.id, fixture.sourceLocationId);
  const destAfterTransfer = await harness.readOnHand(fixture.item.id, fixture.destinationLocationId);

  assert.equal(sourceAfterTransfer, 6);
  assert.equal(destAfterTransfer, 4);

  await harness.voidTransfer(fixture.transfer.movementId, {
    reason: 'projection_balance_regression',
    actor: { type: 'system', id: null },
    idempotencyKey: `void-transfer-balance-${randomUUID()}`
  });

  const sourceAfterReversal = await harness.readOnHand(fixture.item.id, fixture.sourceLocationId);
  const destAfterReversal = await harness.readOnHand(fixture.item.id, fixture.destinationLocationId);

  // If sign is wrong:
  //   source = 2
  //   destination = 8
  // If projection skipped:
  //   source = 6
  //   destination = 4
  assert.equal(sourceAfterReversal, 10);
  assert.equal(destAfterReversal, 0);
  assert.equal(sourceAfterReversal, fixture.sourceInitialOnHand);
  assert.equal(destAfterReversal, fixture.destinationInitialOnHand);
});

test('transfer reversal posts the exact inverse, restores cost exactly, and stays deterministic on replay', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'transfer-reversal-core',
    tenantName: 'Transfer Reversal Core'
  });
  const { tenantId, pool: db } = harness;
  const fixture = await createTransferFixture(harness, { quantity: 7 });

  const originalLines = await readMovementLines(db, tenantId, fixture.transfer.movementId);
  const originalLinks = await readTransferLinks(db, tenantId, fixture.transfer.movementId);
  assert.equal(originalLines.length, 2);
  assert.equal(originalLinks.length, 2);

  const firstReversal = await harness.voidTransfer(fixture.transfer.movementId, {
    reason: 'operator_void',
    actor: { type: 'system', id: null },
    idempotencyKey: `void-transfer-${randomUUID()}`
  });
  const secondReversal = await harness.voidTransfer(fixture.transfer.movementId, {
    reason: 'operator_void',
    actor: { type: 'system', id: null }
  });
  assert.equal(secondReversal.reversalMovementId, firstReversal.reversalMovementId);
  assert.equal(secondReversal.reversalOfMovementId, fixture.transfer.movementId);

  const reversalLines = await readMovementLines(db, tenantId, firstReversal.reversalMovementId);
  const reversalLinks = await readTransferLinks(db, tenantId, firstReversal.reversalMovementId);
  assert.equal(reversalLines.length, originalLines.length);
  assert.equal(reversalLinks.length, originalLinks.length);

  const originalByLocation = new Map(originalLines.map((line) => [line.locationId, line]));
  const reversalByLocation = new Map(reversalLines.map((line) => [line.locationId, line]));
  for (const [locationId, originalLine] of originalByLocation.entries()) {
    const reversalLine = reversalByLocation.get(locationId);
    assert.ok(reversalLine, `missing reversal line for location ${locationId}`);
    assert.equal(reversalLine.itemId, originalLine.itemId);
    assert.ok(Math.abs(reversalLine.effectiveQuantity + originalLine.effectiveQuantity) < 1e-6);
    if (originalLine.extendedCost === null) {
      assert.equal(reversalLine.extendedCost, null);
    } else {
      assert.ok(Math.abs(reversalLine.extendedCost + originalLine.extendedCost) < 1e-6);
    }
  }

  const originalLinkSignatures = new Map();
  for (const row of originalLinks) {
    const signature = `${row.destCostLayerId}|${row.quantity.toFixed(6)}|${row.unitCost.toFixed(6)}|${row.extendedCost.toFixed(6)}`;
    originalLinkSignatures.set(signature, (originalLinkSignatures.get(signature) ?? 0) + 1);
  }
  for (const row of reversalLinks) {
    const signature = `${row.sourceCostLayerId}|${row.quantity.toFixed(6)}|${row.unitCost.toFixed(6)}|${row.extendedCost.toFixed(6)}`;
    const count = originalLinkSignatures.get(signature) ?? 0;
    assert.ok(count > 0, `missing original link signature for reversal ${signature}`);
    originalLinkSignatures.set(signature, count - 1);
  }
  assert.deepEqual([...originalLinkSignatures.values()].every((count) => count === 0), true);

  const sourceBucketsAfterReversal = await readLocationCostBuckets(
    db,
    tenantId,
    fixture.item.id,
    fixture.sourceLocationId
  );
  assert.deepEqual(sourceBucketsAfterReversal, fixture.sourceBucketsBeforeTransfer);
  assert.equal(await harness.readOnHand(fixture.item.id, fixture.sourceLocationId), 10);
  assert.equal(await harness.readOnHand(fixture.item.id, fixture.destinationLocationId), 0);

  const storedReversalState = await readMovementHashAndOccurredAt(
    db,
    tenantId,
    firstReversal.reversalMovementId
  );
  const client = await db.connect();
  try {
    const prepared = await prepareTransferReversalPolicy(
      {
        tenantId,
        originalMovementId: fixture.transfer.movementId
      },
      client
    );
    const planA = buildTransferReversalPlan(prepared, {
      occurredAt: storedReversalState.occurredAt,
      idempotencyKey: null,
      reason: 'operator_void'
    });
    const planB = buildTransferReversalPlan(prepared, {
      occurredAt: storedReversalState.occurredAt,
      idempotencyKey: null,
      reason: 'operator_void'
    });
    assert.equal(planA.expectedDeterministicHash, planB.expectedDeterministicHash);
    assert.equal(planA.expectedDeterministicHash, storedReversalState.deterministicHash);
  } finally {
    client.release();
  }

  await harness.runStrictInvariants();
});

test('transfer reversal is rejected when any destination quantity was consumed', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'transfer-reversal-consumed',
    tenantName: 'Transfer Reversal Consumed'
  });
  const { tenantId, pool: db } = harness;
  const fixture = await createTransferFixture(harness, { quantity: 4 });

  const adjustment = await harness.createInventoryAdjustmentDraft(
    {
      occurredAt: '2026-03-08T00:00:00.000Z',
      reasonCode: 'consume_after_transfer',
      lines: [
        {
          lineNumber: 1,
          itemId: fixture.item.id,
          locationId: fixture.destinationLocationId,
          uom: 'each',
          quantityDelta: -1,
          reasonCode: 'consume_after_transfer'
        }
      ]
    },
    { type: 'system', id: null }
  );
  await harness.postInventoryAdjustmentDraft(adjustment.id, { type: 'system', id: null });

  await assert.rejects(
    harness.voidTransfer(fixture.transfer.movementId, {
      reason: 'must_fail_after_consumption',
      actor: { type: 'system', id: null }
    }),
    (error) => {
      assert.equal(error?.code ?? error?.message, 'TRANSFER_REVERSAL_NOT_POSSIBLE_CONSUMED');
      return true;
    }
  );

  const reversalCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND reversal_of_movement_id = $2`,
    [tenantId, fixture.transfer.movementId]
  );
  assert.equal(Number(reversalCount.rows[0]?.count ?? 0), 0);
});

test('concurrent transfer reversal attempts converge on a single compensating movement', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'transfer-reversal-race',
    tenantName: 'Transfer Reversal Race'
  });
  const { tenantId, pool: db } = harness;
  const fixture = await createTransferFixture(harness, { quantity: 3 });

  const outcomes = await harness.runConcurrently([
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.voidTransfer(fixture.transfer.movementId, {
        reason: 'race_a',
        actor: { type: 'system', id: null },
        idempotencyKey: `void-race-a-${randomUUID()}`
      });
    },
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.voidTransfer(fixture.transfer.movementId, {
        reason: 'race_b',
        actor: { type: 'system', id: null },
        idempotencyKey: `void-race-b-${randomUUID()}`
      });
    }
  ]);

  const fulfilled = outcomes.filter((entry) => entry.status === 'fulfilled');
  assert.equal(fulfilled.length, 2);
  const reversalMovementIds = new Set(fulfilled.map((entry) => entry.value.reversalMovementId));
  assert.equal(reversalMovementIds.size, 1);

  const reversalCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND reversal_of_movement_id = $2`,
    [tenantId, fixture.transfer.movementId]
  );
  assert.equal(Number(reversalCount.rows[0]?.count ?? 0), 1);
  await harness.runStrictInvariants();
});

test('transfer reversal rolls back fully when cost restoration fails after movement persistence begins', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'transfer-reversal-atomic',
    tenantName: 'Transfer Reversal Atomic'
  });
  const { tenantId, pool: db } = harness;
  const fixture = await createTransferFixture(harness, { quantity: 2 });

  const destLayers = await db.query(
    `SELECT l.dest_cost_layer_id
       FROM cost_layer_transfer_links l
      WHERE l.tenant_id = $1
        AND l.transfer_movement_id = $2`,
    [tenantId, fixture.transfer.movementId]
  );
  assert.ok((destLayers.rowCount ?? 0) > 0);

  await db.query(
    `UPDATE inventory_cost_layers
        SET voided_at = now(),
            void_reason = 'transfer_reversal_atomicity_test',
            updated_at = now()
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])`,
    [tenantId, destLayers.rows.map((row) => row.dest_cost_layer_id)]
  );

  const sourceOnHandBefore = await harness.readOnHand(fixture.item.id, fixture.sourceLocationId);
  const destinationOnHandBefore = await harness.readOnHand(fixture.item.id, fixture.destinationLocationId);

  await assert.rejects(
    harness.voidTransfer(fixture.transfer.movementId, {
      reason: 'force_cost_failure',
      actor: { type: 'system', id: null },
      idempotencyKey: `void-atomicity-${randomUUID()}`
    }),
    (error) => {
      assert.ok(
        error?.message === 'TRANSFER_COST_LINK_SOURCE_LAYER_VOIDED'
          || error?.message === 'COST_LAYER_VOIDED_IMMUTABLE'
      );
      return true;
    }
  );

  const reversalCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND reversal_of_movement_id = $2`,
    [tenantId, fixture.transfer.movementId]
  );
  assert.equal(Number(reversalCount.rows[0]?.count ?? 0), 0);
  assert.equal(await harness.readOnHand(fixture.item.id, fixture.sourceLocationId), sourceOnHandBefore);
  assert.equal(await harness.readOnHand(fixture.item.id, fixture.destinationLocationId), destinationOnHandBefore);
});
