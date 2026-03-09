import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { assertMovementContract } from './helpers/mutationContract.mjs';

test('shipment contract writes ledger, emits events, updates projections, and replays cleanly', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'contract-shipment', tenantName: 'Contract Shipment' });
  const { topology } = harness;
  const customer = await harness.createCustomer('SHIP');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'SHIP',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 4
  });
  const order = await harness.createSalesOrder({
    soNumber: `SO-CONTRACT-SHIP-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 4 }]
  });
  const shipment = await harness.createShipment({
    salesOrderId: order.id,
    shippedAt: '2026-03-01T00:00:00.000Z',
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ salesOrderLineId: order.lines[0].id, uom: 'each', quantityShipped: 4 }]
  });
  const posted = await harness.postShipment(shipment.id, {
    idempotencyKey: 'contract-shipment-post',
    actor: { type: 'system', id: null }
  });

  await assertMovementContract({
    harness,
    movementId: posted.inventoryMovementId,
    expectedMovementType: 'issue',
    expectedSourceType: 'shipment_post',
    expectedLineCount: 1,
    expectedBalances: [{ itemId: item.id, locationId: topology.defaults.SELLABLE.id, onHand: 1 }]
  });
});
