import { test, expect } from '../fixtures/test';
import { expectDocumentStatus } from '../assertions/documentAssertions';
import {
  expectMovementLineNetDelta,
  expectReservationFulfillment,
  expectShipmentLineMath
} from '../assertions/fulfillmentAssertions';
import {
  expectAllocatedCommitment,
  expectInventoryBuckets,
  expectReservationCommitments
} from '../assertions/inventoryAssertions';
import {
  expectAvailableLeqOnHand,
  expectNonNegativeBuckets,
  expectReservedSupersetOfAllocated,
  expectZeroReservedImpliesZeroAllocated
} from '../assertions/invariants';
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

function normalize(value: number): number {
  return Number(value.toFixed(6));
}

function expectSnapshotReservedMatchesCommitments(args: {
  snapshotReserved: number;
  reservedOpen: number;
  allocatedOpen: number;
  context: string;
}) {
  const observed = normalize(args.snapshotReserved);
  const expected = normalize(args.reservedOpen + args.allocatedOpen);
  expect(
    observed,
    [
      `Snapshot reservedTotal did not match reservation open commitments (${args.context}).`,
      `snapshotReserved=${observed}`,
      `reservedOpen=${normalize(args.reservedOpen)}`,
      `allocatedOpen=${normalize(args.allocatedOpen)}`
    ].join(' ')
  ).toBe(expected);
}

test('@core allocate reservation preserves submitted SO and commitment math', async ({
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
  await expectDocumentStatus({
    api,
    type: 'salesOrder',
    id: salesOrder.id,
    expected: 'submitted'
  });

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

  const commitmentsBeforeAllocate = await expectReservationCommitments({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    expectedReservedOpen: 12,
    expectedAllocatedOpen: 0
  });

  const reservedBuckets = await expectInventoryBuckets({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    onHand: 30,
    available: 18,
    reservedTotal: 12
  });
  expectNonNegativeBuckets(reservedBuckets);
  expectAvailableLeqOnHand(reservedBuckets);
  expectSnapshotReservedMatchesCommitments({
    snapshotReserved: reservedBuckets.reserved,
    reservedOpen: commitmentsBeforeAllocate.reservedOpen,
    allocatedOpen: commitmentsBeforeAllocate.allocatedOpen,
    context: `reservation=${reservation.id}`
  });

  const allocatedBefore = await expectAllocatedCommitment({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    expectedAllocated: 0
  });
  expectReservedSupersetOfAllocated({
    reservedTotal: reservedBuckets.reserved,
    allocatedOpen: allocatedBefore
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
  await expectDocumentStatus({
    api,
    type: 'salesOrder',
    id: salesOrder.id,
    expected: 'submitted'
  });

  const allocatedAfter = await expectAllocatedCommitment({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    expectedAllocated: 12
  });

  const commitments = await expectReservationCommitments({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    expectedReservedOpen: 0,
    expectedAllocatedOpen: 12
  });

  const allocatedBuckets = await expectInventoryBuckets({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    onHand: 30,
    available: 18,
    reservedTotal: 12
  });
  expectNonNegativeBuckets(allocatedBuckets);
  expectAvailableLeqOnHand(allocatedBuckets);
  expectSnapshotReservedMatchesCommitments({
    snapshotReserved: allocatedBuckets.reserved,
    reservedOpen: commitments.reservedOpen,
    allocatedOpen: commitments.allocatedOpen,
    context: `reservation=${reservation.id}`
  });
  expectReservedSupersetOfAllocated({
    reservedTotal: allocatedBuckets.reserved,
    allocatedOpen: commitments.allocatedOpen
  });
  expectReservedSupersetOfAllocated({
    reservedTotal: allocatedBuckets.reserved,
    allocatedOpen: allocatedAfter
  });

  await page.goto(`/reservations/${reservation.id}`);
  await expect(page.getByRole('heading', { name: 'Reservation detail' })).toBeVisible();
});

test('@core post full shipment decrements on-hand and fully consumes commitment', async ({
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
  await expectDocumentStatus({
    api,
    type: 'salesOrder',
    id: salesOrder.id,
    expected: 'submitted'
  });

  const reservation = await createReservationSeed({
    api,
    salesOrderLineId: soLine.id,
    warehouseId: seeded.warehouse.root.id,
    itemId: seeded.item.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    quantity: 10
  });
  await expectDocumentStatus({
    api,
    type: 'reservation',
    id: reservation.id,
    expected: 'RESERVED',
    warehouseId: seeded.warehouse.root.id
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

  const allocatedBeforeShip = await expectAllocatedCommitment({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    expectedAllocated: 10
  });

  const shipment = await createShipmentSeed({
    api,
    salesOrderId: salesOrder.id,
    salesOrderLineId: soLine.id,
    shipFromLocationId: seeded.warehouse.roles.SELLABLE.id,
    quantity: 10
  });
  const draftShipment = await expectDocumentStatus({
    api,
    type: 'shipment',
    id: shipment.id,
    expected: 'draft'
  });
  expect(
    draftShipment.inventoryMovementId ?? null,
    `Draft shipment should not have inventoryMovementId yet for shipment=${shipment.id}`
  ).toBeNull();

  const shipmentMath = await expectShipmentLineMath({
    api,
    shipmentId: shipment.id,
    allocatedOpenAtShip: allocatedBeforeShip,
    expectedTotalShipped: 10
  });

  const postedShipment = await postShipmentSeed({ api, runId, shipmentId: shipment.id });
  expect(postedShipment.status).toBe('posted');
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

  await expectReservationFulfillment({
    api,
    reservationId: reservation.id,
    warehouseId: seeded.warehouse.root.id,
    expectedStatus: 'FULFILLED',
    expectedQuantityReserved: 10,
    expectedQuantityFulfilled: 10,
    expectedOpenQuantity: 0
  });
  const commitmentsAfterShip = await expectReservationCommitments({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    expectedReservedOpen: 0,
    expectedAllocatedOpen: 0
  });

  const shippedBuckets = await expectInventoryBuckets({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    onHand: 15,
    available: 15,
    reservedTotal: 0
  });
  expectNonNegativeBuckets(shippedBuckets);
  expectAvailableLeqOnHand(shippedBuckets);
  expectSnapshotReservedMatchesCommitments({
    snapshotReserved: shippedBuckets.reserved,
    reservedOpen: commitmentsAfterShip.reservedOpen,
    allocatedOpen: commitmentsAfterShip.allocatedOpen,
    context: `reservation=${reservation.id} shipment=${shipment.id}`
  });

  const allocatedAfterShip = await expectAllocatedCommitment({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    expectedAllocated: 0
  });
  expectReservedSupersetOfAllocated({
    reservedTotal: shippedBuckets.reserved,
    allocatedOpen: allocatedAfterShip
  });
  expectZeroReservedImpliesZeroAllocated({
    reservedTotal: shippedBuckets.reserved,
    allocatedOpen: allocatedAfterShip,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    docId: shipment.id
  });

  await expectDocumentStatus({
    api,
    type: 'salesOrder',
    id: salesOrder.id,
    expected: 'submitted'
  });

  await expectMovementLineNetDelta({
    api,
    movementId: postedShipment.inventoryMovementId,
    expectedNetDelta: -shipmentMath.totalShipped,
    expectedLineDeltas: [
      {
        itemId: seeded.item.id,
        locationId: seeded.warehouse.roles.SELLABLE.id,
        expectedDelta: -shipmentMath.totalShipped
      }
    ]
  });

  await page.goto(`/shipments/${shipment.id}`);
  await expect(page.getByRole('heading', { name: 'Shipment detail' })).toBeVisible();
});

test('@core partial shipment keeps reservation ALLOCATED with remaining open commitment', async ({
  api,
  runId,
  authMeta
}) => {
  const seeded = await seedSellableStockViaInbound({
    api,
    runId,
    label: 'OUT-PART',
    quantity: 25
  });

  const customer = await createOrGetCustomerForRun({
    tenantId: authMeta.tenant.id,
    runId: `${runId}-PART`
  });

  const salesOrder = await createSalesOrderSeed({
    api,
    runId,
    label: 'OUT-PART',
    customerId: customer.id,
    warehouseId: seeded.warehouse.root.id,
    shipFromLocationId: seeded.warehouse.roles.SELLABLE.id,
    itemId: seeded.item.id,
    quantity: 10
  });
  const soLine = must(salesOrder.lines?.[0], 'Expected sales order line is missing.');
  await expectDocumentStatus({
    api,
    type: 'salesOrder',
    id: salesOrder.id,
    expected: 'submitted'
  });

  const reservation = await createReservationSeed({
    api,
    salesOrderLineId: soLine.id,
    warehouseId: seeded.warehouse.root.id,
    itemId: seeded.item.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    quantity: 10
  });
  await expectDocumentStatus({
    api,
    type: 'reservation',
    id: reservation.id,
    expected: 'RESERVED',
    warehouseId: seeded.warehouse.root.id
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

  const allocatedBeforeShip = await expectAllocatedCommitment({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    expectedAllocated: 10
  });

  const shipment = await createShipmentSeed({
    api,
    salesOrderId: salesOrder.id,
    salesOrderLineId: soLine.id,
    shipFromLocationId: seeded.warehouse.roles.SELLABLE.id,
    quantity: 4
  });
  await expectDocumentStatus({
    api,
    type: 'shipment',
    id: shipment.id,
    expected: 'draft'
  });

  const shipmentMath = await expectShipmentLineMath({
    api,
    shipmentId: shipment.id,
    allocatedOpenAtShip: allocatedBeforeShip,
    expectedTotalShipped: 4
  });

  const postedShipment = await postShipmentSeed({ api, runId, shipmentId: shipment.id });
  expect(postedShipment.status).toBe('posted');
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
  await expectReservationFulfillment({
    api,
    reservationId: reservation.id,
    warehouseId: seeded.warehouse.root.id,
    expectedStatus: 'ALLOCATED',
    expectedQuantityReserved: 10,
    expectedQuantityFulfilled: 4,
    expectedOpenQuantity: 6
  });

  const commitmentsAfterPartialShip = await expectReservationCommitments({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    expectedReservedOpen: 0,
    expectedAllocatedOpen: 6
  });

  const bucketsAfterPartialShip = await expectInventoryBuckets({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    onHand: 21,
    available: 15,
    reservedTotal: 6
  });
  expectNonNegativeBuckets(bucketsAfterPartialShip);
  expectAvailableLeqOnHand(bucketsAfterPartialShip);
  expectSnapshotReservedMatchesCommitments({
    snapshotReserved: bucketsAfterPartialShip.reserved,
    reservedOpen: commitmentsAfterPartialShip.reservedOpen,
    allocatedOpen: commitmentsAfterPartialShip.allocatedOpen,
    context: `reservation=${reservation.id} shipment=${shipment.id}`
  });
  expectReservedSupersetOfAllocated({
    reservedTotal: bucketsAfterPartialShip.reserved,
    allocatedOpen: commitmentsAfterPartialShip.allocatedOpen
  });

  await expectMovementLineNetDelta({
    api,
    movementId: postedShipment.inventoryMovementId,
    expectedNetDelta: -shipmentMath.totalShipped,
    expectedLineDeltas: [
      {
        itemId: seeded.item.id,
        locationId: seeded.warehouse.roles.SELLABLE.id,
        expectedDelta: -shipmentMath.totalShipped
      }
    ]
  });

  await expectDocumentStatus({
    api,
    type: 'salesOrder',
    id: salesOrder.id,
    expected: 'submitted'
  });
});

test('@core cancel ALLOCATED reservation transitions to CANCELLED and restores availability', async ({
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
  await expectDocumentStatus({
    api,
    type: 'salesOrder',
    id: salesOrder.id,
    expected: 'submitted'
  });

  const reservation = await createReservationSeed({
    api,
    salesOrderLineId: soLine.id,
    warehouseId: seeded.warehouse.root.id,
    itemId: seeded.item.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    quantity: 5
  });
  await expectDocumentStatus({
    api,
    type: 'reservation',
    id: reservation.id,
    expected: 'RESERVED',
    warehouseId: seeded.warehouse.root.id
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
  await expectReservationCommitments({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    expectedReservedOpen: 0,
    expectedAllocatedOpen: 5
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

  const commitments = await expectReservationCommitments({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    expectedReservedOpen: 0,
    expectedAllocatedOpen: 0
  });

  const restoredBuckets = await expectInventoryBuckets({
    api,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    onHand: 12,
    available: 12,
    reservedTotal: 0
  });
  expectNonNegativeBuckets(restoredBuckets);
  expectAvailableLeqOnHand(restoredBuckets);
  expectSnapshotReservedMatchesCommitments({
    snapshotReserved: restoredBuckets.reserved,
    reservedOpen: commitments.reservedOpen,
    allocatedOpen: commitments.allocatedOpen,
    context: `reservation=${reservation.id}`
  });
  expectReservedSupersetOfAllocated({
    reservedTotal: restoredBuckets.reserved,
    allocatedOpen: commitments.allocatedOpen
  });
  expectZeroReservedImpliesZeroAllocated({
    reservedTotal: restoredBuckets.reserved,
    allocatedOpen: commitments.allocatedOpen,
    sku: seeded.item.sku,
    warehouseId: seeded.warehouse.root.id,
    locationId: seeded.warehouse.roles.SELLABLE.id,
    docId: reservation.id
  });
});
