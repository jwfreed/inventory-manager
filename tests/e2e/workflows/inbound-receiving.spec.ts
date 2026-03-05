import { test, expect } from '../fixtures/test';
import { expectDocumentStatus } from '../assertions/documentAssertions';
import { expectInventoryBuckets } from '../assertions/inventoryAssertions';
import {
  createAndPostPutaway,
  createApprovedPurchaseOrder,
  createItemSeed,
  createVendorSeed,
  createWarehouseSeed,
  postQcAccept,
  postReceipt
} from '../fixtures/seed';

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

test('receive purchase order in full updates stock and PO status', async ({ api, runId, page }) => {
  const warehouse = await createWarehouseSeed({ api, runId, label: 'INB-FULL' });
  const item = await createItemSeed({
    api,
    runId,
    label: 'INB-FULL',
    defaultLocationId: warehouse.roles.SELLABLE.id,
    requiresQc: true
  });
  const vendor = await createVendorSeed({ api, runId, label: 'INB-FULL' });

  const purchaseOrder = await createApprovedPurchaseOrder({
    api,
    runId,
    label: 'INB-FULL',
    vendorId: vendor.id,
    itemId: item.id,
    shipToLocationId: warehouse.root.id,
    receivingLocationId: warehouse.roles.QA.id,
    quantity: 10
  });

  const poLine = must(purchaseOrder.lines?.[0], 'Expected purchase order line is missing.');
  const receipt = await postReceipt({
    api,
    runId,
    purchaseOrderId: purchaseOrder.id,
    purchaseOrderLineId: poLine.id,
    quantity: 10
  });

  await expectDocumentStatus({ api, type: 'receipt', id: receipt.id, expected: 'posted' });
  await expectDocumentStatus({ api, type: 'purchaseOrder', id: purchaseOrder.id, expected: 'received' });

  await expectInventoryBuckets({
    api,
    sku: item.sku,
    warehouseId: warehouse.root.id,
    locationId: warehouse.roles.QA.id,
    onHand: 10,
    available: 10,
    reservedTotal: 0,
    inTransit: 0
  });

  await page.goto(`/purchase-orders/${purchaseOrder.id}`);
  await expect(page.getByRole('heading', { name: /Purchase Order/i })).toBeVisible();

  await page.goto(`/receipts/${receipt.id}`);
  await expect(page.getByText('Receipt Detail')).toBeVisible();
});

test('receive purchase order partial keeps PO open with remaining quantity', async ({ api, runId, page }) => {
  const warehouse = await createWarehouseSeed({ api, runId, label: 'INB-PART' });
  const item = await createItemSeed({
    api,
    runId,
    label: 'INB-PART',
    defaultLocationId: warehouse.roles.SELLABLE.id,
    requiresQc: true
  });
  const vendor = await createVendorSeed({ api, runId, label: 'INB-PART' });

  const purchaseOrder = await createApprovedPurchaseOrder({
    api,
    runId,
    label: 'INB-PART',
    vendorId: vendor.id,
    itemId: item.id,
    shipToLocationId: warehouse.root.id,
    receivingLocationId: warehouse.roles.QA.id,
    quantity: 20
  });

  const poLine = must(purchaseOrder.lines?.[0], 'Expected purchase order line is missing.');
  const receipt = await postReceipt({
    api,
    runId,
    purchaseOrderId: purchaseOrder.id,
    purchaseOrderLineId: poLine.id,
    quantity: 8
  });

  await expectDocumentStatus({ api, type: 'receipt', id: receipt.id, expected: 'posted' });
  await expectDocumentStatus({
    api,
    type: 'purchaseOrder',
    id: purchaseOrder.id,
    expected: 'partially_received'
  });

  await expectInventoryBuckets({
    api,
    sku: item.sku,
    warehouseId: warehouse.root.id,
    locationId: warehouse.roles.QA.id,
    onHand: 8,
    available: 8,
    reservedTotal: 0,
    inTransit: 0
  });

  await page.goto(`/purchase-orders/${purchaseOrder.id}`);
  await expect(page.getByText('Partially received')).toBeVisible();
});

test('putaway moves accepted stock to target location', async ({ api, runId, page }) => {
  const warehouse = await createWarehouseSeed({ api, runId, label: 'INB-PUT' });
  const item = await createItemSeed({
    api,
    runId,
    label: 'INB-PUT',
    defaultLocationId: warehouse.roles.SELLABLE.id,
    requiresQc: true
  });
  const vendor = await createVendorSeed({ api, runId, label: 'INB-PUT' });

  const purchaseOrder = await createApprovedPurchaseOrder({
    api,
    runId,
    label: 'INB-PUT',
    vendorId: vendor.id,
    itemId: item.id,
    shipToLocationId: warehouse.root.id,
    receivingLocationId: warehouse.roles.QA.id,
    quantity: 6
  });

  const poLine = must(purchaseOrder.lines?.[0], 'Expected purchase order line is missing.');
  const receipt = await postReceipt({
    api,
    runId,
    purchaseOrderId: purchaseOrder.id,
    purchaseOrderLineId: poLine.id,
    quantity: 6
  });

  const receiptLine = must(receipt.lines?.[0], 'Expected receipt line is missing.');
  await postQcAccept({ api, receiptLineId: receiptLine.id, quantity: 6 });

  const overflowSellable = await api.post<{ id: string }>('/locations', {
    code: `PUT-${runId}`.slice(0, 40),
    name: `Putaway Target ${runId}`,
    type: 'bin',
    role: 'SELLABLE',
    isSellable: true,
    parentLocationId: warehouse.root.id
  });

  const putaway = await createAndPostPutaway({
    api,
    runId,
    receiptId: receipt.id,
    receiptLineId: receiptLine.id,
    quantity: 6,
    fromLocationId: warehouse.roles.SELLABLE.id,
    toLocationId: overflowSellable.id
  });

  await expectDocumentStatus({ api, type: 'putaway', id: putaway.id, expected: 'completed' });

  await expectInventoryBuckets({
    api,
    sku: item.sku,
    warehouseId: warehouse.root.id,
    locationId: warehouse.roles.SELLABLE.id,
    onHand: 0,
    reservedTotal: 0
  });

  await expectInventoryBuckets({
    api,
    sku: item.sku,
    warehouseId: warehouse.root.id,
    locationId: overflowSellable.id,
    onHand: 6,
    reservedTotal: 0
  });

  await page.goto(`/receiving/putaway?receiptId=${receipt.id}`);
  await expect(page.getByText('Plan putaway')).toBeVisible();
});
