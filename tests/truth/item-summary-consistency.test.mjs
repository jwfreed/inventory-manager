import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Item Summary Consistency Truth Tests
//
// Prove that items.quantity_on_hand and items.average_cost are updated
// in real-time by every quantity-affecting mutation workflow, WITHOUT
// requiring a background rebuild job.
//
// Invariant: After any mutation that affects on-hand quantity, the item
// summary must immediately reflect the ledger-derived truth.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the item summary (quantity_on_hand, average_cost) directly from the
 * items table for the given item.
 */
async function readItemSummary(harness, itemId) {
  const result = await harness.pool.query(
    `SELECT COALESCE(quantity_on_hand, 0)::numeric AS quantity_on_hand,
            average_cost
       FROM items
      WHERE id = $1 AND tenant_id = $2`,
    [itemId, harness.tenantId]
  );
  assert.equal(result.rows.length, 1, `item ${itemId} must exist`);
  return {
    quantityOnHand: Number(result.rows[0].quantity_on_hand),
    averageCost: result.rows[0].average_cost === null ? null : Number(result.rows[0].average_cost)
  };
}

test('seedStockViaCount updates item summary in real-time', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-isrc-seed',
    tenantName: 'Truth Item Summary Seed'
  });
  const { topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'ISR-SEED',
    type: 'raw'
  });

  const before = await readItemSummary(harness, item.id);
  assert.equal(before.quantityOnHand, 0, 'quantity starts at zero');

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 25,
    unitCost: 4
  });

  const after = await readItemSummary(harness, item.id);
  assert.equal(after.quantityOnHand, 25, 'quantity_on_hand reflects seeded stock immediately');
  assert.ok(after.averageCost !== null, 'average_cost is populated');
});

test('adjustment updates item summary in real-time', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-isrc-adj',
    tenantName: 'Truth Item Summary Adjustment'
  });
  const { topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'ISR-ADJ',
    type: 'raw'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 50,
    unitCost: 3
  });

  const adj = await harness.createInventoryAdjustmentDraft(
    {
      occurredAt: '2026-06-01T00:00:00.000Z',
      reasonCode: 'isr_damage',
      lines: [{
        lineNumber: 1,
        itemId: item.id,
        locationId: topology.defaults.SELLABLE.id,
        uom: 'each',
        quantityDelta: -10,
        reasonCode: 'isr_damage'
      }]
    },
    { type: 'system', id: null }
  );
  await harness.postInventoryAdjustmentDraft(adj.id, { type: 'system', id: null });

  const after = await readItemSummary(harness, item.id);
  assert.equal(after.quantityOnHand, 40, 'item summary reflects adjustment immediately');
});

test('shipment posting updates item summary in real-time', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-isrc-ship',
    tenantName: 'Truth Item Summary Shipment'
  });
  const { topology } = harness;

  const store = await harness.createWarehouseWithSellable('ISR-SHIP-STORE');
  const customer = await harness.createCustomer('ISR-SHIP');

  const item = await harness.createItem({
    defaultLocationId: store.sellable.id,
    skuPrefix: 'ISR-SHIP',
    type: 'raw'
  });

  await harness.seedStockViaCount({
    warehouseId: store.warehouse.id,
    itemId: item.id,
    locationId: store.sellable.id,
    quantity: 20,
    unitCost: 5
  });

  const beforeShipment = await readItemSummary(harness, item.id);
  assert.equal(beforeShipment.quantityOnHand, 20, 'before shipment');

  const order = await harness.createSalesOrder({
    soNumber: `SO-ISR-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'submitted',
    warehouseId: store.warehouse.id,
    shipFromLocationId: store.sellable.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 7 }]
  });
  const shipment = await harness.createShipment({
    salesOrderId: order.id,
    shippedAt: '2026-06-02T00:00:00.000Z',
    shipFromLocationId: store.sellable.id,
    lines: [{ salesOrderLineId: order.lines[0].id, uom: 'each', quantityShipped: 7 }]
  });
  await harness.postShipment(shipment.id, {
    idempotencyKey: `isr-ship:${randomUUID()}`,
    actor: { type: 'system', id: null }
  });

  const afterShipment = await readItemSummary(harness, item.id);
  assert.equal(afterShipment.quantityOnHand, 13, 'item summary reflects shipment immediately (20 - 7)');
  assert.ok(afterShipment.averageCost !== null, 'average_cost still populated after shipment');
});

test('WO material issue updates item summary in real-time', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-isrc-woiss',
    tenantName: 'Truth Item Summary WO Issue'
  });
  const { topology } = harness;

  const component = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'ISR-COMP',
    type: 'raw'
  });
  const output = await harness.createItem({
    defaultLocationId: topology.defaults.QA.id,
    skuPrefix: 'ISR-OUT',
    type: 'finished'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: component.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 30,
    unitCost: 2
  });

  const bom = await harness.createBomAndActivate({
    outputItemId: output.id,
    components: [{ componentItemId: component.id, quantityPer: 3 }],
    suffix: randomUUID().slice(0, 6)
  });
  const workOrder = await harness.createWorkOrder({
    kind: 'production',
    outputItemId: output.id,
    outputUom: 'each',
    quantityPlanned: 5,
    bomId: bom.id,
    defaultConsumeLocationId: topology.defaults.SELLABLE.id,
    defaultProduceLocationId: topology.defaults.QA.id
  });

  const beforeIssue = await readItemSummary(harness, component.id);
  assert.equal(beforeIssue.quantityOnHand, 30, 'before WO issue');

  // reportProduction issues components AND completes output in one call
  await harness.reportProduction(
    workOrder.id,
    {
      warehouseId: topology.warehouse.id,
      outputQty: 5,
      outputUom: 'each',
      occurredAt: '2026-06-03T00:00:00.000Z',
      idempotencyKey: `isr-wo-report:${randomUUID()}`
    },
    {},
    { idempotencyKey: `isr-wo-report:${randomUUID()}` }
  );

  // Component: 30 - (5 × 3) = 15 consumed
  const afterComponent = await readItemSummary(harness, component.id);
  assert.equal(afterComponent.quantityOnHand, 15, 'component item summary reflects issue immediately (30 - 15)');

  // Output: 5 produced
  const afterOutput = await readItemSummary(harness, output.id);
  assert.equal(afterOutput.quantityOnHand, 5, 'output item summary reflects completion immediately');
  assert.ok(afterOutput.averageCost !== null, 'output average_cost populated after production');
});

test('transfer does not change total item summary quantity', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-isrc-xfer',
    tenantName: 'Truth Item Summary Transfer'
  });
  const { topology } = harness;

  const store = await harness.createWarehouseWithSellable('ISR-XFER-STORE');

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'ISR-XFER',
    type: 'raw'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 40,
    unitCost: 6
  });

  const before = await readItemSummary(harness, item.id);
  assert.equal(before.quantityOnHand, 40, 'before transfer');

  await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId: item.id,
    quantity: 15,
    uom: 'each',
    reasonCode: 'isr_transfer',
    notes: 'Transfer test',
    idempotencyKey: `isr-xfer:${randomUUID()}`
  });

  // Transfer moves stock between locations but total on-hand should not change
  const after = await readItemSummary(harness, item.id);
  assert.equal(after.quantityOnHand, 40, 'item summary total unchanged after transfer');
});

test('item summary matches ledger-derived rebuild after every workflow type', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-isrc-all',
    tenantName: 'Truth Item Summary Full Pipeline'
  });
  const { topology } = harness;

  const store = await harness.createWarehouseWithSellable('ISR-ALL-STORE');
  const vendor = await harness.createVendor('ISR-ALL');
  const customer = await harness.createCustomer('ISR-ALL');

  const rawItem = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'ISR-RAW',
    type: 'raw'
  });

  // 1. Seed stock
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: rawItem.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 100,
    unitCost: 2
  });

  // 2. Adjustment: remove 10
  const adj = await harness.createInventoryAdjustmentDraft(
    {
      occurredAt: '2026-06-01T00:00:00.000Z',
      reasonCode: 'isr_shrink',
      lines: [{
        lineNumber: 1,
        itemId: rawItem.id,
        locationId: topology.defaults.SELLABLE.id,
        uom: 'each',
        quantityDelta: -10,
        reasonCode: 'isr_shrink'
      }]
    },
    { type: 'system', id: null }
  );
  await harness.postInventoryAdjustmentDraft(adj.id, { type: 'system', id: null });

  // 3. Transfer 20 to store
  await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId: rawItem.id,
    quantity: 20,
    uom: 'each',
    reasonCode: 'isr_replenish',
    notes: 'Full pipeline transfer',
    idempotencyKey: `isr-all-xfer:${randomUUID()}`
  });

  // 4. Ship 5 from store
  const order = await harness.createSalesOrder({
    soNumber: `SO-ISR-ALL-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'submitted',
    warehouseId: store.warehouse.id,
    shipFromLocationId: store.sellable.id,
    lines: [{ itemId: rawItem.id, uom: 'each', quantityOrdered: 5 }]
  });
  const shipment = await harness.createShipment({
    salesOrderId: order.id,
    shippedAt: '2026-06-02T00:00:00.000Z',
    shipFromLocationId: store.sellable.id,
    lines: [{ salesOrderLineId: order.lines[0].id, uom: 'each', quantityShipped: 5 }]
  });
  await harness.postShipment(shipment.id, {
    idempotencyKey: `isr-all-ship:${randomUUID()}`,
    actor: { type: 'system', id: null }
  });

  // Expected: 100 - 10 (adj) - 5 (shipped) = 85 on-hand total
  const liveSnapshot = await readItemSummary(harness, rawItem.id);
  assert.equal(liveSnapshot.quantityOnHand, 85, 'live item summary correct after full pipeline');

  // 5. Rebuild from ledger and verify match
  const snapshotBefore = await harness.snapshotDerivedProjections();
  await harness.clearDerivedProjections();
  await harness.rebuildDerivedProjections();
  const snapshotAfter = await harness.snapshotDerivedProjections();

  const liveSummary = snapshotBefore.itemSummaries.find(s => s.itemId === rawItem.id);
  const rebuiltSummary = snapshotAfter.itemSummaries.find(s => s.itemId === rawItem.id);
  assert.ok(liveSummary, 'live summary exists');
  assert.ok(rebuiltSummary, 'rebuilt summary exists');
  assert.equal(liveSummary.quantityOnHand, rebuiltSummary.quantityOnHand,
    'live item summary matches ledger-derived rebuild');
  assert.equal(liveSummary.averageCost, rebuiltSummary.averageCost,
    'live average_cost matches ledger-derived rebuild');
});
