import test from 'node:test';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { assertMovementContract } from './helpers/mutationContract.mjs';

test('receive contract writes ledger, emits events, updates projections, and replays cleanly', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'contract-receive', tenantName: 'Contract Receive' });
  const { topology } = harness;
  const vendor = await harness.createVendor('RECV');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'RECEIVE',
    type: 'raw'
  });
  const purchaseOrder = await harness.createPurchaseOrder({
    vendorId: vendor.id,
    shipToLocationId: topology.defaults.SELLABLE.id,
    receivingLocationId: topology.defaults.SELLABLE.id,
    expectedDate: '2026-02-10',
    status: 'approved',
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 8, unitCost: 4.25, currencyCode: 'THB' }]
  });
  const receipt = await harness.postReceipt({
    purchaseOrderId: purchaseOrder.id,
    receivedAt: '2026-02-11T00:00:00.000Z',
    idempotencyKey: 'contract-receive',
    lines: [{ purchaseOrderLineId: purchaseOrder.lines[0].id, uom: 'each', quantityReceived: 8, unitCost: 4.25 }]
  });

  await assertMovementContract({
    harness,
    movementId: receipt.receipt.inventoryMovementId,
    expectedMovementType: 'receive',
    expectedSourceType: 'po_receipt',
    expectedLineCount: 1,
    expectedBalances: [{ itemId: item.id, locationId: topology.defaults.QA.id, onHand: 8 }]
  });
});
