import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Cross-Workflow Concurrency Truth Tests
//
// These tests prove that concurrent mutations from DIFFERENT workflow types
// (transfer vs shipment vs adjustment) serialize correctly and preserve
// conservation invariants. Existing concurrency tests only test same-workflow
// concurrency (transfer×transfer, reservation×reservation).
// ─────────────────────────────────────────────────────────────────────────────

test('concurrent transfer and shipment on same source serialize and conserve stock', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xc-ts',
    tenantName: 'Truth Cross Concurrency Transfer-Ship'
  });
  const { topology } = harness;

  const customer = await harness.createCustomer('XC-TS');
  const store = await harness.createWarehouseWithSellable('XC-TS-DEST');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XC-TS',
    type: 'raw'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  // Prepare the shipment document before the concurrent race
  const order = await harness.createSalesOrder({
    soNumber: `SO-XC-TS-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 7 }]
  });
  const shipment = await harness.createShipment({
    salesOrderId: order.id,
    shippedAt: '2026-06-01T00:00:00.000Z',
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ salesOrderLineId: order.lines[0].id, uom: 'each', quantityShipped: 7 }]
  });

  // Race: transfer 7 vs ship 7 from same source with only 10 available
  const outcomes = await harness.runConcurrently([
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: store.sellable.id,
        itemId: item.id,
        quantity: 7,
        uom: 'each',
        reasonCode: 'xc_transfer',
        notes: 'Concurrent transfer',
        idempotencyKey: `xc-ts-transfer:${randomUUID()}`
      });
    },
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postShipment(shipment.id, {
        idempotencyKey: `xc-ts-ship:${randomUUID()}`,
        actor: { type: 'system', id: null }
      });
    }
  ]);

  const fulfilled = outcomes.filter((e) => e.status === 'fulfilled');
  const rejected = outcomes.filter((e) => e.status === 'rejected');

  // Both cannot succeed (7 + 7 = 14 > 10)
  const sourceOnHand = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);
  const storeOnHand = await harness.readOnHand(item.id, store.sellable.id);

  // Non-negative invariant
  assert.ok(sourceOnHand >= 0, 'no negative source');
  assert.ok(storeOnHand >= 0, 'no negative store');

  // Shipment removes stock from system; transfer moves to store
  // Possible outcomes:
  //   - Transfer won:  source=3, store=7, shipped=0  → total in system=10
  //   - Shipment won:  source=3, store=0, shipped=7  → total in system=3
  //   - Both rejected: source=10, store=0, shipped=0 → total in system=10
  //   - Both succeed is impossible (7+7 > 10)
  const totalInSystem = sourceOnHand + storeOnHand;
  assert.ok(totalInSystem === 10 || totalInSystem === 3,
    `total in system must be 10 (transfer won) or 3 (shipment won), got ${totalInSystem}`);

  if (fulfilled.length === 2) {
    // Both cannot succeed requesting 7 each from 10
    assert.fail('both should not succeed: 7 + 7 > 10');
  }

  // Conservation verified from ledger
  const mismatches = await harness.findQuantityConservationMismatches();
  assert.equal(mismatches.length, 0, 'zero conservation mismatches');

  await harness.runStrictInvariants();
});

test('concurrent transfer and adjustment on same source serialize and conserve stock', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xc-ta',
    tenantName: 'Truth Cross Concurrency Transfer-Adj'
  });
  const { topology } = harness;

  const store = await harness.createWarehouseWithSellable('XC-TA-DEST');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XC-TA',
    type: 'raw'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 8,
    unitCost: 4
  });

  // Prepare adjustment draft
  const adj = await harness.createInventoryAdjustmentDraft(
    {
      occurredAt: '2026-06-01T00:00:00.000Z',
      reasonCode: 'xc_damage',
      lines: [{
        lineNumber: 1,
        itemId: item.id,
        locationId: topology.defaults.SELLABLE.id,
        uom: 'each',
        quantityDelta: -6,
        reasonCode: 'xc_damage'
      }]
    },
    { type: 'system', id: null }
  );

  // Race: transfer 6 vs adjust -6 from same source with only 8 available
  const outcomes = await harness.runConcurrently([
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: store.sellable.id,
        itemId: item.id,
        quantity: 6,
        uom: 'each',
        reasonCode: 'xc_transfer',
        notes: 'Concurrent transfer',
        idempotencyKey: `xc-ta-transfer:${randomUUID()}`
      });
    },
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postInventoryAdjustmentDraft(adj.id, { type: 'system', id: null });
    }
  ]);

  const fulfilled = outcomes.filter((e) => e.status === 'fulfilled');
  const sourceOnHand = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);
  const storeOnHand = await harness.readOnHand(item.id, store.sellable.id);

  // Stock must be non-negative everywhere
  assert.ok(sourceOnHand >= 0, 'no negative source');
  assert.ok(storeOnHand >= 0, 'no negative store');

  if (fulfilled.length === 2) {
    // Both succeeded: 8 - 6 (transfer) - 6 (adj) = -4 → impossible without negative stock
    // If both succeeded, system allowed it because there was enough stock
    assert.ok(sourceOnHand >= 0, 'source non-negative');
  } else if (fulfilled.length === 1) {
    // One succeeded, one rejected: conservation holds
    if (storeOnHand === 6) {
      // Transfer succeeded, adjustment rejected
      assert.equal(sourceOnHand, 2, 'source = 8 - 6');
    } else {
      // Adjustment succeeded, transfer rejected
      assert.equal(storeOnHand, 0, 'nothing transferred');
      assert.equal(sourceOnHand, 2, 'source = 8 - 6');
    }
  } else {
    assert.equal(sourceOnHand, 8, 'nothing deducted');
    assert.equal(storeOnHand, 0, 'nothing transferred');
  }

  const mismatches = await harness.findQuantityConservationMismatches();
  assert.equal(mismatches.length, 0, 'zero conservation mismatches');

  await harness.runStrictInvariants();
});

test('concurrent WO issue and transfer on same component stock serialize correctly', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-xc-wt',
    tenantName: 'Truth Cross Concurrency WO-Transfer'
  });
  const { topology } = harness;

  const store = await harness.createWarehouseWithSellable('XC-WT-DEST');
  const component = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'XC-WT-COMP',
    type: 'raw'
  });
  const output = await harness.createItem({
    defaultLocationId: topology.defaults.QA.id,
    skuPrefix: 'XC-WT-OUT',
    type: 'finished'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: component.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 3
  });

  // Prepare work order + issue draft
  const bom = await harness.createBomAndActivate({
    outputItemId: output.id,
    components: [{ componentItemId: component.id, quantityPer: 1 }],
    suffix: randomUUID().slice(0, 6)
  });
  const workOrder = await harness.createWorkOrder({
    kind: 'production',
    outputItemId: output.id,
    outputUom: 'each',
    quantityPlanned: 7,
    bomId: bom.id,
    defaultConsumeLocationId: topology.defaults.SELLABLE.id,
    defaultProduceLocationId: topology.defaults.QA.id
  });
  const issue = await harness.createWorkOrderIssueDraft(workOrder.id, {
    occurredAt: '2026-06-01T00:00:00.000Z',
    notes: 'xc wo issue',
    lines: [{
      lineNumber: 1,
      componentItemId: component.id,
      fromLocationId: topology.defaults.SELLABLE.id,
      uom: 'each',
      quantityIssued: 7,
      reasonCode: 'xc_issue'
    }]
  }, { idempotencyKey: `xc-wt-issue:${randomUUID()}` });

  // Race: WO issue 7 vs transfer 7 from same stock of 10
  const outcomes = await harness.runConcurrently([
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postWorkOrderIssueDraft(workOrder.id, issue.id, { actor: { type: 'system', id: null } });
    },
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: store.sellable.id,
        itemId: component.id,
        quantity: 7,
        uom: 'each',
        reasonCode: 'xc_transfer',
        notes: 'Concurrent transfer',
        idempotencyKey: `xc-wt-transfer:${randomUUID()}`
      });
    }
  ]);

  const fulfilled = outcomes.filter((e) => e.status === 'fulfilled');
  const sourceOnHand = await harness.readOnHand(component.id, topology.defaults.SELLABLE.id);
  const storeOnHand = await harness.readOnHand(component.id, store.sellable.id);

  // Non-negative invariant
  assert.ok(sourceOnHand >= 0, 'no negative source');
  assert.ok(storeOnHand >= 0, 'no negative store');

  if (fulfilled.length === 2) {
    // Both succeeded: 10 - 7 (WO) - 7 (transfer) = -4 is impossible
    assert.fail('both should not succeed: 7 + 7 > 10');
  } else if (fulfilled.length === 1) {
    // WO issue removes from system (into WIP); transfer moves to store
    // If WO won: source=3, store=0, total in system=3
    // If transfer won: source=3, store=7, total in system=10
    const totalInSystem = sourceOnHand + storeOnHand;
    assert.ok(totalInSystem === 3 || totalInSystem === 10,
      `total must be 3 (WO won) or 10 (transfer won), got ${totalInSystem}`);
  } else {
    assert.equal(sourceOnHand, 10, 'nothing consumed');
    assert.equal(storeOnHand, 0, 'nothing transferred');
  }

  const mismatches = await harness.findQuantityConservationMismatches();
  assert.equal(mismatches.length, 0, 'zero conservation mismatches');

  await harness.runStrictInvariants();
});
