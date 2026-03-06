import { test, expect } from '../fixtures/test';
import { expectDocumentStatus } from '../assertions/documentAssertions';
import { expectMovementLineNetDelta } from '../assertions/fulfillmentAssertions';
import { expectInventoryBuckets } from '../assertions/inventoryAssertions';
import {
  expectAvailableLeqOnHand,
  expectConservationDelta,
  expectNonNegativeBuckets
} from '../assertions/invariants';
import {
  createWarehouseSeed,
  postInventoryTransfer,
  seedSellableStockViaInbound
} from '../fixtures/seed';

test('@core transfer between warehouses posts immediately with no in-transit state', async ({
  api,
  runId,
  page
}) => {
  const source = await seedSellableStockViaInbound({
    api,
    runId,
    label: 'XFER-SRC',
    quantity: 20
  });

  const destination = await createWarehouseSeed({
    api,
    runId,
    label: 'XFER-DST'
  });

  const sourceBefore = await expectInventoryBuckets({
    api,
    sku: source.item.sku,
    warehouseId: source.warehouse.root.id,
    locationId: source.warehouse.roles.SELLABLE.id,
    onHand: 20,
    available: 20,
    reservedTotal: 0,
    inTransit: 0
  });
  expectNonNegativeBuckets(sourceBefore);
  expectAvailableLeqOnHand(sourceBefore);

  const transfer = await postInventoryTransfer({
    api,
    runId,
    sourceLocationId: source.warehouse.roles.SELLABLE.id,
    destinationLocationId: destination.roles.SELLABLE.id,
    itemId: source.item.id,
    quantity: 8
  });

  const movement = await expectDocumentStatus({
    api,
    type: 'movement',
    id: transfer.movementId,
    expected: 'posted'
  });
  expect(movement.movementType).toBe('transfer');

  const movementLines = await api.get<{
    data: Array<{ locationId: string; itemId: string; quantityDelta: number }>;
  }>(`/inventory-movements/${transfer.movementId}/lines`);

  const lines = movementLines.data ?? [];
  const sourceLine = lines.find(
    (line) => line.locationId === source.warehouse.roles.SELLABLE.id && line.itemId === source.item.id
  );
  const destinationLine = lines.find(
    (line) => line.locationId === destination.roles.SELLABLE.id && line.itemId === source.item.id
  );

  expect(sourceLine).toBeDefined();
  expect(destinationLine).toBeDefined();
  expect(Number(sourceLine?.quantityDelta)).toBe(-8);
  expect(Number(destinationLine?.quantityDelta)).toBe(8);

  await expectMovementLineNetDelta({
    api,
    movementId: transfer.movementId,
    expectedNetDelta: 0,
    expectedLineDeltas: [
      {
        itemId: source.item.id,
        locationId: source.warehouse.roles.SELLABLE.id,
        expectedDelta: -8
      },
      {
        itemId: source.item.id,
        locationId: destination.roles.SELLABLE.id,
        expectedDelta: 8
      }
    ]
  });

  const sourceAfter = await expectInventoryBuckets({
    api,
    sku: source.item.sku,
    warehouseId: source.warehouse.root.id,
    locationId: source.warehouse.roles.SELLABLE.id,
    onHand: 12,
    available: 12,
    reservedTotal: 0,
    inTransit: 0
  });
  expectNonNegativeBuckets(sourceAfter);
  expectAvailableLeqOnHand(sourceAfter);

  const destinationAfter = await expectInventoryBuckets({
    api,
    sku: source.item.sku,
    warehouseId: destination.root.id,
    locationId: destination.roles.SELLABLE.id,
    onHand: 8,
    available: 8,
    reservedTotal: 0,
    inTransit: 0
  });
  expectNonNegativeBuckets(destinationAfter);
  expectAvailableLeqOnHand(destinationAfter);
  expectConservationDelta({
    sourceBefore: sourceBefore.onHand,
    sourceAfter: sourceAfter.onHand,
    destBefore: 0,
    destAfter: destinationAfter.onHand,
    qty: 8
  });

  await page.goto(`/movements/${transfer.movementId}`);
  await expect(page.getByRole('heading', { name: 'Movement detail' })).toBeVisible();
});
