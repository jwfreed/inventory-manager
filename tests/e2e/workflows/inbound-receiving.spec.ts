import { test, expect } from '../fixtures/test';
import { expectDocumentStatus } from '../assertions/documentAssertions';
import { expectInventoryBuckets } from '../assertions/inventoryAssertions';
import {
  expectAvailableLeqOnHand,
  expectConservationDelta,
  expectNonNegativeBuckets
} from '../assertions/invariants';
import { expectPurchaseOrderLineMath } from '../assertions/poAssertions';
import {
  createApprovedPurchaseOrder,
  createItemSeed,
  createPutawayDraft,
  createVendorSeed,
  createWarehouseSeed,
  postQcAccept,
  postReceipt
} from '../fixtures/seed';

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

test('@core receive purchase order in full updates stock and PO status', async ({ api, runId, page }) => {
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
  await page.goto(`/receiving/receipt?poId=${purchaseOrder.id}`);
  await expect(page.getByRole('heading', { name: 'Receive Goods' })).toBeVisible();

  const postReceiptButton = page.getByRole('button', { name: /Post receipt/i });
  await expect(postReceiptButton).toBeEnabled();
  await postReceiptButton.click();
  await expect(page.getByText(/Receipt posted successfully/i)).toBeVisible();

  await expect
    .poll(
      () => new URL(page.url()).searchParams.get('receiptId'),
      {
        timeout: 15_000,
        intervals: [300, 600],
        message: `Receipt ID did not appear in URL after posting PO ${purchaseOrder.id} from UI.`
      }
    )
    .not.toBeNull();

  const receiptId = new URL(page.url()).searchParams.get('receiptId');
  if (!receiptId) {
    throw new Error(`Receipt ID missing in URL after posting UI receipt for purchaseOrder=${purchaseOrder.id}.`);
  }

  await expectDocumentStatus({ api, type: 'receipt', id: receiptId, expected: 'posted' });
  await expectDocumentStatus({ api, type: 'purchaseOrder', id: purchaseOrder.id, expected: 'received' });

  const qaBuckets = await expectInventoryBuckets({
    api,
    sku: item.sku,
    warehouseId: warehouse.root.id,
    locationId: warehouse.roles.QA.id,
    onHand: 10,
    available: 10,
    reservedTotal: 0,
    inTransit: 0
  });
  expectNonNegativeBuckets(qaBuckets);
  expectAvailableLeqOnHand(qaBuckets);

  await expectPurchaseOrderLineMath({
    api,
    purchaseOrderId: purchaseOrder.id,
    lineId: poLine.id,
    expectedOrdered: 10,
    expectedReceivedTotal: 10
  });

  await page.goto(`/purchase-orders/${purchaseOrder.id}`);
  await expect(page.getByRole('heading', { name: /Purchase Order/i })).toBeVisible();

  await page.goto(`/receipts/${receiptId}`);
  await expect(page.getByText('Receipt Detail')).toBeVisible();
});

test('@core receive purchase order partial keeps PO open with remaining quantity', async ({ api, runId, page }) => {
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

  const qaBuckets = await expectInventoryBuckets({
    api,
    sku: item.sku,
    warehouseId: warehouse.root.id,
    locationId: warehouse.roles.QA.id,
    onHand: 8,
    available: 8,
    reservedTotal: 0,
    inTransit: 0
  });
  expectNonNegativeBuckets(qaBuckets);
  expectAvailableLeqOnHand(qaBuckets);

  await expectPurchaseOrderLineMath({
    api,
    purchaseOrderId: purchaseOrder.id,
    lineId: poLine.id,
    expectedOrdered: 20,
    expectedReceivedTotal: 8
  });

  await page.goto(`/purchase-orders/${purchaseOrder.id}`);
  await expect(page.getByText('Partially received')).toBeVisible();
});

test('@core putaway moves accepted stock to target location', async ({ api, runId, page }) => {
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

  const sourceBefore = await expectInventoryBuckets({
    api,
    sku: item.sku,
    warehouseId: warehouse.root.id,
    locationId: warehouse.roles.SELLABLE.id,
    onHand: 6,
    available: 6,
    reservedTotal: 0,
    inTransit: 0
  });
  expectNonNegativeBuckets(sourceBefore);
  expectAvailableLeqOnHand(sourceBefore);

  const putaway = await createPutawayDraft({
    api,
    receiptId: receipt.id,
    receiptLineId: receiptLine.id,
    quantity: 6,
    fromLocationId: warehouse.roles.SELLABLE.id,
    toLocationId: overflowSellable.id
  });

  await page.goto(`/receiving/putaway?receiptId=${receipt.id}&putawayId=${putaway.id}`);
  await expect(page.getByRole('heading', { name: 'Plan putaway' })).toBeVisible();
  await page.getByRole('button', { name: /Post putaway/i }).click();
  await expect(page.getByRole('heading', { name: 'Putaway complete' })).toBeVisible();

  await expectDocumentStatus({ api, type: 'putaway', id: putaway.id, expected: 'completed' });

  const sourceAfter = await expectInventoryBuckets({
    api,
    sku: item.sku,
    warehouseId: warehouse.root.id,
    locationId: warehouse.roles.SELLABLE.id,
    onHand: 0,
    available: 0,
    inTransit: 0,
    reservedTotal: 0
  });

  const destinationAfter = await expectInventoryBuckets({
    api,
    sku: item.sku,
    warehouseId: warehouse.root.id,
    locationId: overflowSellable.id,
    onHand: 6,
    available: 6,
    inTransit: 0,
    reservedTotal: 0
  });
  expectNonNegativeBuckets(sourceAfter);
  expectAvailableLeqOnHand(sourceAfter);
  expectNonNegativeBuckets(destinationAfter);
  expectAvailableLeqOnHand(destinationAfter);
  expectConservationDelta({
    sourceBefore: sourceBefore.onHand,
    sourceAfter: sourceAfter.onHand,
    destBefore: 0,
    destAfter: destinationAfter.onHand,
    qty: 6
  });
});
