import { test, expect } from '../fixtures/test';
import { expectDocumentStatus } from '../assertions/documentAssertions';
import { expectInventoryBuckets } from '../assertions/inventoryAssertions';
import {
  createWarehouseSeed,
  postInventoryTransfer,
  seedSellableStockViaInbound
} from '../fixtures/seed';

test('transfer between warehouses posts movement and updates bucket deltas', async ({
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

  const transfer = await postInventoryTransfer({
    api,
    runId,
    sourceLocationId: source.warehouse.roles.SELLABLE.id,
    destinationLocationId: destination.roles.SELLABLE.id,
    itemId: source.item.id,
    quantity: 8
  });

  await expectDocumentStatus({
    api,
    type: 'movement',
    id: transfer.movementId,
    expected: 'posted'
  });

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

  await expectInventoryBuckets({
    api,
    sku: source.item.sku,
    warehouseId: source.warehouse.root.id,
    locationId: source.warehouse.roles.SELLABLE.id,
    onHand: 12,
    available: 12,
    reservedTotal: 0,
    inTransit: 0
  });

  await expectInventoryBuckets({
    api,
    sku: source.item.sku,
    warehouseId: destination.root.id,
    locationId: destination.roles.SELLABLE.id,
    onHand: 8,
    available: 8,
    reservedTotal: 0,
    inTransit: 0
  });

  await page.goto(`/movements/${transfer.movementId}`);
  await expect(page.getByRole('heading', { name: 'Movement detail' })).toBeVisible();
});
