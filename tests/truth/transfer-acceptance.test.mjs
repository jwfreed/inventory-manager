import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// T-1, T-2, T-3, T-4: Balance conservation, movement structure, event coverage
// ─────────────────────────────────────────────────────────────────────────────

test('transfer full quantity produces zero-sum balance with 2 movement lines, deterministic hash, and unit event coverage', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xfer-full',
    tenantName: 'Truth Transfer Full'
  });
  const { topology, tenantId, pool: db } = harness;
  const dest = await harness.createWarehouseWithSellable('XFER-FULL-DST');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XFER-FULL',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  const transfer = await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: dest.sellable.id,
    itemId: item.id,
    quantity: 10,
    uom: 'each',
    reasonCode: 'truth_full',
    notes: 'Full quantity transfer',
    idempotencyKey: `truth-full:${randomUUID()}`
  });

  assert.equal(transfer.created, true);

  // T-2: Source fully decremented
  const sourceOnHand = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);
  assert.equal(sourceOnHand, 0, 'source should be fully decremented');

  // T-3: Destination receives full quantity
  const destOnHand = await harness.readOnHand(item.id, dest.sellable.id);
  assert.equal(destOnHand, 10, 'destination should receive full quantity');

  // T-1: Zero-sum conservation
  assert.equal(sourceOnHand + destOnHand, 10, 'total on_hand unchanged');

  // T-4: Exactly 2 movement lines
  const lines = await db.query(
    `SELECT id, quantity_delta::numeric AS qty, location_id
       FROM inventory_movement_lines
      WHERE tenant_id = $1 AND movement_id = $2
      ORDER BY quantity_delta ASC`,
    [tenantId, transfer.movementId]
  );
  assert.equal(lines.rowCount, 2, 'exactly 2 movement lines');
  assert.ok(Number(lines.rows[0].qty) < 0, 'first line is outbound');
  assert.ok(Number(lines.rows[1].qty) > 0, 'second line is inbound');
  assert.equal(
    Math.abs(Number(lines.rows[0].qty)),
    Number(lines.rows[1].qty),
    'outbound and inbound magnitudes match'
  );

  // Deterministic hash present
  const mv = await db.query(
    `SELECT movement_deterministic_hash
       FROM inventory_movements
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, transfer.movementId]
  );
  assert.match(mv.rows[0].movement_deterministic_hash, /^[a-f0-9]{64}$/);

  // Every movement line has at least one inventory_unit_event
  for (const line of lines.rows) {
    const events = await db.query(
      `SELECT COUNT(*)::int AS count
         FROM inventory_unit_events
        WHERE tenant_id = $1 AND movement_line_id = $2`,
      [tenantId, line.id]
    );
    assert.ok(
      Number(events.rows[0].count) >= 1,
      `movement line ${line.id} missing unit events`
    );
  }

  // Domain events emitted for this movement
  const mvEvents = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_events
      WHERE tenant_id = $1
        AND aggregate_type = 'inventory_movement'
        AND aggregate_id = $2`,
    [tenantId, transfer.movementId]
  );
  assert.ok(Number(mvEvents.rows[0].count) >= 1, 'movement posted event emitted');

  await harness.runStrictInvariants();
});

test('transfer partial quantity decrements source and increments destination with total conservation', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xfer-partial',
    tenantName: 'Truth Transfer Partial'
  });
  const { topology } = harness;
  const dest = await harness.createWarehouseWithSellable('XFER-PRT-DST');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XFER-PRT',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  const transfer = await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: dest.sellable.id,
    itemId: item.id,
    quantity: 4,
    uom: 'each',
    reasonCode: 'truth_partial',
    notes: 'Partial quantity transfer',
    idempotencyKey: `truth-partial:${randomUUID()}`
  });

  assert.equal(transfer.created, true);
  const sourceOnHand = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);
  const destOnHand = await harness.readOnHand(item.id, dest.sellable.id);
  assert.equal(sourceOnHand, 6);
  assert.equal(destOnHand, 4);
  assert.equal(sourceOnHand + destOnHand, 10, 'total on_hand conserved');

  await harness.runStrictInvariants();
});

// ─────────────────────────────────────────────────────────────────────────────
// T-5: Precondition enforcement
// ─────────────────────────────────────────────────────────────────────────────

test('transfer precondition enforcement rejects invalid inputs without modifying state', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xfer-pre',
    tenantName: 'Truth Transfer Preconditions'
  });
  const { topology } = harness;
  const dest = await harness.createWarehouseWithSellable('XFER-PRE-DST');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XFER-PRE',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  // Zero quantity → TRANSFER_INVALID_QUANTITY
  await assert.rejects(
    harness.postTransfer({
      sourceLocationId: topology.defaults.SELLABLE.id,
      destinationLocationId: dest.sellable.id,
      itemId: item.id,
      quantity: 0,
      uom: 'each',
      reasonCode: 'truth_zero',
      idempotencyKey: `truth-zero:${randomUUID()}`
    }),
    /TRANSFER_INVALID_QUANTITY/
  );

  // Negative quantity → TRANSFER_INVALID_QUANTITY
  await assert.rejects(
    harness.postTransfer({
      sourceLocationId: topology.defaults.SELLABLE.id,
      destinationLocationId: dest.sellable.id,
      itemId: item.id,
      quantity: -5,
      uom: 'each',
      reasonCode: 'truth_negative',
      idempotencyKey: `truth-neg:${randomUUID()}`
    }),
    /TRANSFER_INVALID_QUANTITY/
  );

  // Same location → TRANSFER_SAME_LOCATION
  await assert.rejects(
    harness.postTransfer({
      sourceLocationId: topology.defaults.SELLABLE.id,
      destinationLocationId: topology.defaults.SELLABLE.id,
      itemId: item.id,
      quantity: 5,
      uom: 'each',
      reasonCode: 'truth_same',
      idempotencyKey: `truth-same:${randomUUID()}`
    }),
    /TRANSFER_SAME_LOCATION/
  );

  // Insufficient stock without override → rejection
  await assert.rejects(
    harness.postTransfer({
      sourceLocationId: topology.defaults.SELLABLE.id,
      destinationLocationId: dest.sellable.id,
      itemId: item.id,
      quantity: 100,
      uom: 'each',
      reasonCode: 'truth_insufficient',
      idempotencyKey: `truth-insuff:${randomUUID()}`
    })
  );

  // State unchanged after all rejections
  const onHand = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);
  assert.equal(onHand, 10, 'stock unchanged after all rejected transfers');
});

// ─────────────────────────────────────────────────────────────────────────────
// T-6: Cross-warehouse transfer
// ─────────────────────────────────────────────────────────────────────────────

test('cross-warehouse transfer succeeds and tracks source and destination warehouse correctly', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xfer-cross',
    tenantName: 'Truth Transfer Cross Warehouse'
  });
  const { topology } = harness;
  const dest = await harness.createWarehouseWithSellable('XFER-CRS-DST');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XFER-CRS',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  const transfer = await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: dest.sellable.id,
    itemId: item.id,
    quantity: 7,
    uom: 'each',
    reasonCode: 'truth_cross_wh',
    notes: 'Cross-warehouse transfer',
    idempotencyKey: `truth-cross:${randomUUID()}`
  });

  assert.equal(transfer.created, true);
  assert.equal(transfer.sourceWarehouseId, topology.warehouse.id);
  assert.equal(transfer.destinationWarehouseId, dest.warehouse.id);
  assert.notEqual(transfer.sourceWarehouseId, transfer.destinationWarehouseId);

  const sourceOnHand = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);
  const destOnHand = await harness.readOnHand(item.id, dest.sellable.id);
  assert.equal(sourceOnHand, 3);
  assert.equal(destOnHand, 7);
  assert.equal(sourceOnHand + destOnHand, 10, 'total on_hand conserved across warehouses');

  await harness.runStrictInvariants();
});

// ─────────────────────────────────────────────────────────────────────────────
// CL-3: Cost layer relocation integrity
// ─────────────────────────────────────────────────────────────────────────────

test('transfer relocates cost layers with quantity and cost conservation', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xfer-cost',
    tenantName: 'Truth Transfer Cost'
  });
  const { topology, tenantId, pool: db } = harness;
  const dest = await harness.createWarehouseWithSellable('XFER-CST-DST');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XFER-CST',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  const transfer = await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: dest.sellable.id,
    itemId: item.id,
    quantity: 4,
    uom: 'each',
    reasonCode: 'truth_cost',
    notes: 'Cost layer transfer',
    idempotencyKey: `truth-cost:${randomUUID()}`
  });

  // Transfer links created
  const links = await db.query(
    `SELECT COUNT(*)::int AS count,
            COALESCE(SUM(quantity), 0)::numeric AS total_qty,
            COALESCE(SUM(extended_cost), 0)::numeric AS total_cost
       FROM cost_layer_transfer_links
      WHERE tenant_id = $1 AND transfer_movement_id = $2`,
    [tenantId, transfer.movementId]
  );
  assert.ok(Number(links.rows[0].count) >= 1, 'transfer cost links created');
  assert.equal(Number(links.rows[0].total_qty), 4, 'linked quantity matches transfer');
  assert.equal(Number(links.rows[0].total_cost), 20, 'linked cost = 4 × $5');

  // Destination cost layers created by transfer
  const destLayers = await db.query(
    `SELECT COALESCE(SUM(original_quantity), 0)::numeric AS qty,
            COALESCE(SUM(extended_cost), 0)::numeric AS cost
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND movement_id = $2
        AND source_type = 'transfer_in'
        AND voided_at IS NULL`,
    [tenantId, transfer.movementId]
  );
  assert.equal(Number(destLayers.rows[0].qty), 4, 'destination cost layer quantity');
  assert.equal(Number(destLayers.rows[0].cost), 20, 'destination cost layer cost');

  // Source cost layers consumed by transfer
  const consumed = await db.query(
    `SELECT COALESCE(SUM(consumed_quantity), 0)::numeric AS qty,
            COALESCE(SUM(extended_cost), 0)::numeric AS cost
       FROM cost_layer_consumptions
      WHERE tenant_id = $1 AND movement_id = $2`,
    [tenantId, transfer.movementId]
  );
  assert.equal(Number(consumed.rows[0].qty), 4, 'consumed quantity matches');
  assert.equal(Number(consumed.rows[0].cost), 20, 'consumed cost matches');

  // Cost conservation: consumed cost = destination layer cost
  assert.equal(
    Number(consumed.rows[0].cost),
    Number(destLayers.rows[0].cost),
    'cost conserved across relocation'
  );

  await harness.runStrictInvariants();
});

// ─────────────────────────────────────────────────────────────────────────────
// T-7: Void reversal restores balances and cost layers
// ─────────────────────────────────────────────────────────────────────────────

test('transfer void restores source and destination balances and creates reversal movement', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xfer-void',
    tenantName: 'Truth Transfer Void'
  });
  const { topology, tenantId, pool: db } = harness;
  const dest = await harness.createWarehouseWithSellable('XFER-VD-DST');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XFER-VD',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  const transfer = await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: dest.sellable.id,
    itemId: item.id,
    quantity: 4,
    uom: 'each',
    reasonCode: 'truth_void',
    notes: 'Transfer to void',
    idempotencyKey: `truth-void-xfer:${randomUUID()}`
  });

  // Verify post-transfer state
  assert.equal(await harness.readOnHand(item.id, topology.defaults.SELLABLE.id), 6);
  assert.equal(await harness.readOnHand(item.id, dest.sellable.id), 4);

  // Void the transfer
  const voidResult = await harness.voidTransfer(transfer.movementId, {
    reason: 'truth test void',
    actor: { type: 'system' },
    idempotencyKey: `truth-void:${randomUUID()}`
  });

  // T-7: Balances restored
  assert.equal(await harness.readOnHand(item.id, topology.defaults.SELLABLE.id), 10);
  assert.equal(await harness.readOnHand(item.id, dest.sellable.id), 0);

  // Reversal movement created
  const reversal = await db.query(
    `SELECT reversal_of_movement_id, movement_type, movement_deterministic_hash
       FROM inventory_movements
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, voidResult.reversalMovementId]
  );
  assert.equal(reversal.rowCount, 1);
  assert.equal(reversal.rows[0].reversal_of_movement_id, transfer.movementId);
  assert.equal(reversal.rows[0].movement_type, 'transfer_reversal');
  assert.match(reversal.rows[0].movement_deterministic_hash, /^[a-f0-9]{64}$/);

  // Original movement remains immutable (append-only ledger)
  // Reversal is linked via reversal_of_movement_id on the reversal movement
  const originalReversalLink = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND reversal_of_movement_id = $2`,
    [tenantId, transfer.movementId]
  );
  assert.equal(Number(originalReversalLink.rows[0].count), 1, 'exactly one reversal points to original');

  // Destination cost layers consumed by the reversal (relocated back to source)
  const destLayerRemaining = await db.query(
    `SELECT COALESCE(SUM(remaining_quantity), 0)::numeric AS remaining
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND movement_id = $2
        AND source_type = 'transfer_in'`,
    [tenantId, transfer.movementId]
  );
  assert.equal(
    Number(destLayerRemaining.rows[0].remaining),
    0,
    'destination cost layers fully consumed by reversal'
  );

  await harness.runStrictInvariants();
});

// ─────────────────────────────────────────────────────────────────────────────
// T-8: Void blocked after destination consumption
// ─────────────────────────────────────────────────────────────────────────────

test('transfer void is blocked when destination cost layers have been consumed by subsequent transfer', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xfer-vb',
    tenantName: 'Truth Transfer Void Blocked'
  });
  const { topology } = harness;
  const middle = await harness.createWarehouseWithSellable('XFER-VB-MID');
  const finalDest = await harness.createWarehouseWithSellable('XFER-VB-FIN');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XFER-VB',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  // Transfer A → B
  const firstTransfer = await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: middle.sellable.id,
    itemId: item.id,
    quantity: 5,
    uom: 'each',
    reasonCode: 'truth_vb_first',
    idempotencyKey: `truth-vb1:${randomUUID()}`
  });

  // Transfer B → C (consumes cost layers at B)
  await harness.postTransfer({
    sourceLocationId: middle.sellable.id,
    destinationLocationId: finalDest.sellable.id,
    itemId: item.id,
    quantity: 5,
    uom: 'each',
    reasonCode: 'truth_vb_second',
    idempotencyKey: `truth-vb2:${randomUUID()}`
  });

  // Void A → B should fail (destination cost layers consumed)
  await assert.rejects(
    harness.voidTransfer(firstTransfer.movementId, {
      reason: 'attempted void after consumption',
      actor: { type: 'system' },
      idempotencyKey: `truth-vb-void:${randomUUID()}`
    })
  );

  // Balances unchanged after failed void
  assert.equal(await harness.readOnHand(item.id, topology.defaults.SELLABLE.id), 5);
  assert.equal(await harness.readOnHand(item.id, middle.sellable.id), 0);
  assert.equal(await harness.readOnHand(item.id, finalDest.sellable.id), 5);

  // Total on_hand still conserved
  const total =
    (await harness.readOnHand(item.id, topology.defaults.SELLABLE.id)) +
    (await harness.readOnHand(item.id, middle.sellable.id)) +
    (await harness.readOnHand(item.id, finalDest.sellable.id));
  assert.equal(total, 10, 'total on_hand conserved');

  await harness.runStrictInvariants();
});

// ─────────────────────────────────────────────────────────────────────────────
// Void idempotency: repeated void returns same result
// ─────────────────────────────────────────────────────────────────────────────

test('transfer void is idempotent and repeated void returns same reversal movement', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xfer-videm',
    tenantName: 'Truth Transfer Void Idempotency'
  });
  const { topology, tenantId, pool: db } = harness;
  const dest = await harness.createWarehouseWithSellable('XFER-VI-DST');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XFER-VI',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  const transfer = await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: dest.sellable.id,
    itemId: item.id,
    quantity: 4,
    uom: 'each',
    reasonCode: 'truth_void_idem',
    idempotencyKey: `truth-videm-xfer:${randomUUID()}`
  });

  const voidKey = `truth-videm-void:${randomUUID()}`;
  const firstVoid = await harness.voidTransfer(transfer.movementId, {
    reason: 'truth void idempotency',
    actor: { type: 'system' },
    idempotencyKey: voidKey
  });
  const secondVoid = await harness.voidTransfer(transfer.movementId, {
    reason: 'truth void idempotency',
    actor: { type: 'system' },
    idempotencyKey: voidKey
  });

  assert.equal(firstVoid.reversalMovementId, secondVoid.reversalMovementId);

  // Only one reversal movement exists
  const reversals = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND reversal_of_movement_id = $2`,
    [tenantId, transfer.movementId]
  );
  assert.equal(Number(reversals.rows[0].count), 1, 'exactly one reversal movement');

  await harness.runStrictInvariants();
});
