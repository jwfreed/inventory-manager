import { test, expect } from '../fixtures/test';
import { expectDocumentStatus } from '../assertions/documentAssertions';
import {
  expectAllocatedCommitment,
  expectInventoryBuckets,
  expectReservationCommitments
} from '../assertions/inventoryAssertions';
import { createOrGetCustomerForRun } from '../fixtures/db';
import {
  allocateReservationSeed,
  cancelReservationSeed,
  createReservationSeed,
  createSalesOrderSeed,
  createShipmentSeed,
  postShipmentSeed,
  seedSellableStockViaInbound
} from '../fixtures/seed';

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

test('create sales order and allocate reservation with correct commitment semantics', async ({
  api,
  runId,
  authMeta,
  page
}) => {
  const seeded = await seedSellableStockViaInbound({
    api,
    runId,
    label: 'OUT-ALLOC',
    quantity: 30
  });

  const customer = await createOrGetCustomerForRun({
    tenantId: authMeta.tenant.id,
    runId: `${runId}-ALLOC`
  });

  const salesOrder = await createSalesOrderSeed({
    api,
    runId,
    label: 'OUT-ALLOC',
    customerId: customer.id,
    warehouseId: seeded.warehouse.root.id,
    shipFromLocationId: seeded.warehouse.roles.SELLABLE.id,
    itemId: seeded.item.id,
    quantity: 12
  });

  const soLine = must(salesOrder.lines?.[0], 'Expected sales order line is missing.');

  const reservation = await createReservationSeed({
    api,
    salesOrderLineId: soLine.id,
    warehouseId: seeded.warehouse.root.id,
    itemId: seeded.item.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    quantity: 12
  });

  await expectDocumentStatus({
    api,
    type: 'reservation',
    id: reservation.id,
    expected: 'RESERVED',
    warehouseId: seeded.warehouse.root.id
  });

  await expectInventoryBuckets({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    onHand: 30,
    available: 18,
    reservedTotal: 12
  });

  await expectAllocatedCommitment({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    expectedAllocated: 0
  });

  await allocateReservationSeed({
    api,
    runId,
    reservationId: reservation.id,
    warehouseId: seeded.warehouse.root.id
  });

  await expectDocumentStatus({
    api,
    type: 'reservation',
    id: reservation.id,
    expected: 'ALLOCATED',
    warehouseId: seeded.warehouse.root.id
  });

  await expectAllocatedCommitment({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    expectedAllocated: 12
  });

  await expectReservationCommitments({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    expectedReservedOpen: 0,
    expectedAllocatedOpen: 12
  });

  await expectInventoryBuckets({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    onHand: 30,
    available: 18,
    reservedTotal: 12
  });

  await page.goto(`/reservations/${reservation.id}`);
  await expect(page.getByRole('heading', { name: 'Reservation detail' })).toBeVisible();
});

test('post shipment decrements on-hand and clears allocated commitment', async ({
  api,
  runId,
  authMeta,
  page
}) => {
  const seeded = await seedSellableStockViaInbound({
    api,
    runId,
    label: 'OUT-SHIP',
    quantity: 25
  });

  const customer = await createOrGetCustomerForRun({
    tenantId: authMeta.tenant.id,
    runId: `${runId}-SHIP`
  });

  const salesOrder = await createSalesOrderSeed({
    api,
    runId,
    label: 'OUT-SHIP',
    customerId: customer.id,
    warehouseId: seeded.warehouse.root.id,
    shipFromLocationId: seeded.warehouse.roles.SELLABLE.id,
    itemId: seeded.item.id,
    quantity: 10
  });
  const soLine = must(salesOrder.lines?.[0], 'Expected sales order line is missing.');

  const reservation = await createReservationSeed({
    api,
    salesOrderLineId: soLine.id,
    warehouseId: seeded.warehouse.root.id,
    itemId: seeded.item.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    quantity: 10
  });

  await allocateReservationSeed({
    api,
    runId,
    reservationId: reservation.id,
    warehouseId: seeded.warehouse.root.id
  });

  const shipment = await createShipmentSeed({
    api,
    salesOrderId: salesOrder.id,
    salesOrderLineId: soLine.id,
    shipFromLocationId: seeded.warehouse.roles.SELLABLE.id,
    quantity: 10
  });

  const postedShipment = await postShipmentSeed({ api, runId, shipmentId: shipment.id });
  await expectDocumentStatus({ api, type: 'shipment', id: shipment.id, expected: 'posted' });

  if (!postedShipment.inventoryMovementId) {
    throw new Error('Posted shipment is missing inventoryMovementId.');
  }

  await expectDocumentStatus({
    api,
    type: 'movement',
    id: postedShipment.inventoryMovementId,
    expected: 'posted'
  });

  await expectDocumentStatus({
    api,
    type: 'reservation',
    id: reservation.id,
    expected: 'FULFILLED',
    warehouseId: seeded.warehouse.root.id
  });

  await expectInventoryBuckets({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    onHand: 15,
    available: 15,
    reservedTotal: 0
  });

  await expectAllocatedCommitment({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    expectedAllocated: 0
  });

  await expectDocumentStatus({
    api,
    type: 'salesOrder',
    id: salesOrder.id,
    expected: ['submitted', 'shipped', 'closed']
  });

  await page.goto(`/shipments/${shipment.id}`);
  await expect(page.getByRole('heading', { name: 'Shipment detail' })).toBeVisible();
});

test('exception flow: cancel allocated reservation restores availability', async ({
  api,
  runId,
  authMeta
}) => {
  const seeded = await seedSellableStockViaInbound({
    api,
    runId,
    label: 'OUT-CANCEL',
    quantity: 12
  });

  const customer = await createOrGetCustomerForRun({
    tenantId: authMeta.tenant.id,
    runId: `${runId}-CANCEL`
  });

  const salesOrder = await createSalesOrderSeed({
    api,
    runId,
    label: 'OUT-CANCEL',
    customerId: customer.id,
    warehouseId: seeded.warehouse.root.id,
    shipFromLocationId: seeded.warehouse.roles.SELLABLE.id,
    itemId: seeded.item.id,
    quantity: 5
  });
  const soLine = must(salesOrder.lines?.[0], 'Expected sales order line is missing.');

  const reservation = await createReservationSeed({
    api,
    salesOrderLineId: soLine.id,
    warehouseId: seeded.warehouse.root.id,
    itemId: seeded.item.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    quantity: 5
  });

  await allocateReservationSeed({
    api,
    runId,
    reservationId: reservation.id,
    warehouseId: seeded.warehouse.root.id
  });

  await cancelReservationSeed({
    api,
    runId,
    reservationId: reservation.id,
    warehouseId: seeded.warehouse.root.id,
    reason: 'E2E cancellation exception flow'
  });

  await expectDocumentStatus({
    api,
    type: 'reservation',
    id: reservation.id,
    expected: 'CANCELLED',
    warehouseId: seeded.warehouse.root.id
  });

  await expectReservationCommitments({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    expectedReservedOpen: 0,
    expectedAllocatedOpen: 0
  });

  await expectInventoryBuckets({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    onHand: 12,
    available: 12,
    reservedTotal: 0
  });
});
