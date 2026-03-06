import { expect } from '@playwright/test';
import { E2EApiClient } from './apiClient';

type Location = {
  id: string;
  code: string;
  name: string;
  type: string;
  role: 'SELLABLE' | 'QA' | 'HOLD' | 'REJECT' | 'SCRAP' | null;
  warehouseId?: string | null;
};

type Item = {
  id: string;
  sku: string;
  name: string;
};

type Vendor = {
  id: string;
  code: string;
  name: string;
};

type PurchaseOrderLine = {
  id: string;
  itemId: string;
  uom: string;
  quantityOrdered: number;
};

type PurchaseOrder = {
  id: string;
  poNumber: string;
  status: string;
  lines: PurchaseOrderLine[];
};

type ReceiptLine = {
  id: string;
  purchaseOrderLineId: string;
  quantityReceived: number;
  uom: string;
};

type Receipt = {
  id: string;
  status: string;
  lines: ReceiptLine[];
};

type Putaway = {
  id: string;
  status: string;
  lines: Array<{ id: string; status: string }>;
};

type SalesOrderLine = {
  id: string;
  itemId: string;
  quantityOrdered: number;
  uom: string;
};

type SalesOrder = {
  id: string;
  soNumber: string;
  status: string;
  lines: SalesOrderLine[];
};

type Reservation = {
  id: string;
  status: string;
  warehouseId: string;
  itemId: string;
  locationId: string;
  uom: string;
  quantityReserved: number;
  quantityFulfilled: number;
};

type Shipment = {
  id: string;
  status: string | null;
  inventoryMovementId?: string | null;
};

type WarehouseRoleMap = {
  SELLABLE: Location;
  QA: Location;
  HOLD: Location;
  REJECT: Location;
  SCRAP: Location;
};

export type WarehouseSeed = {
  root: Location;
  roles: WarehouseRoleMap;
};

function normalizeToken(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .toUpperCase()
    .slice(0, 24) || 'E2E';
}

const REQUIRED_WAREHOUSE_ROLES: Array<keyof WarehouseRoleMap> = [
  'SELLABLE',
  'QA',
  'HOLD',
  'REJECT',
  'SCRAP'
];
const WAREHOUSE_ROLE_MAX_ATTEMPTS = 30;
const WAREHOUSE_ROLE_RETRY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

async function listLocations(api: E2EApiClient): Promise<Location[]> {
  const response = await api.get<{ data: Location[] }>('/locations', {
    params: { limit: 500, offset: 0, active: true }
  });
  return response.data ?? [];
}

async function resolveWarehouseRoles(api: E2EApiClient, warehouseId: string): Promise<WarehouseRoleMap> {
  let inWarehouse: Location[] = [];

  for (let attempt = 1; attempt <= WAREHOUSE_ROLE_MAX_ATTEMPTS; attempt += 1) {
    const all = await listLocations(api);
    inWarehouse = all.filter((location) => location.warehouseId === warehouseId);

    const missingRoles = REQUIRED_WAREHOUSE_ROLES.filter(
      (role) => !inWarehouse.some((location) => location.role === role)
    );
    if (missingRoles.length === 0) {
      const pickRole = (role: keyof WarehouseRoleMap): Location => {
        const match = inWarehouse.find((location) => location.role === role);
        return must(match, `Missing ${role} location in warehouse ${warehouseId}.`);
      };

      return {
        SELLABLE: pickRole('SELLABLE'),
        QA: pickRole('QA'),
        HOLD: pickRole('HOLD'),
        REJECT: pickRole('REJECT'),
        SCRAP: pickRole('SCRAP')
      };
    }

    if (attempt < WAREHOUSE_ROLE_MAX_ATTEMPTS) {
      await sleep(WAREHOUSE_ROLE_RETRY_MS);
    }
  }

  const foundRoles = REQUIRED_WAREHOUSE_ROLES.filter((role) =>
    inWarehouse.some((location) => location.role === role)
  );
  const missingRoles = REQUIRED_WAREHOUSE_ROLES.filter(
    (role) => !inWarehouse.some((location) => location.role === role)
  );
  const locationSample =
    inWarehouse
      .slice(0, 12)
      .map((location) => `${location.code}:${location.role ?? 'null'}`)
      .join(', ') || '<none>';
  const totalWaitMs = (WAREHOUSE_ROLE_MAX_ATTEMPTS - 1) * WAREHOUSE_ROLE_RETRY_MS;

  throw new Error(
    [
      `Warehouse role locations did not become ready for warehouseId=${warehouseId}.`,
      `Attempts=${WAREHOUSE_ROLE_MAX_ATTEMPTS}.`,
      `TotalWaitMs=${totalWaitMs}.`,
      `FoundRoles=${foundRoles.length ? foundRoles.join(',') : '<none>'}.`,
      `MissingRoles=${missingRoles.join(',')}.`,
      `LocationSample=${locationSample}.`
    ].join(' ')
  );
}

export async function createWarehouseSeed(args: {
  api: E2EApiClient;
  runId: string;
  label: string;
}): Promise<WarehouseSeed> {
  const token = normalizeToken(`${args.label}-${args.runId}`);
  const code = `WH-${token}`.slice(0, 64);

  const root = await args.api.post<Location>('/locations', {
    code,
    name: `Warehouse ${args.label}`,
    type: 'warehouse'
  });

  const roles = await resolveWarehouseRoles(args.api, root.id);
  expect(roles.SELLABLE.id).toBeTruthy();

  return { root, roles };
}

export async function createItemSeed(args: {
  api: E2EApiClient;
  runId: string;
  label: string;
  defaultLocationId: string;
  requiresQc?: boolean;
}): Promise<Item> {
  const token = normalizeToken(`${args.label}-${args.runId}`);
  const sku = `SKU-${token}`.slice(0, 64);

  return await args.api.post<Item>('/items', {
    sku,
    name: `E2E Item ${args.label}`,
    type: 'finished',
    uomDimension: 'count',
    canonicalUom: 'each',
    stockingUom: 'each',
    defaultLocationId: args.defaultLocationId,
    requiresQc: args.requiresQc ?? true
  });
}

export async function createVendorSeed(args: {
  api: E2EApiClient;
  runId: string;
  label: string;
}): Promise<Vendor> {
  const token = normalizeToken(`${args.label}-${args.runId}`);
  return await args.api.post<Vendor>('/vendors', {
    code: `V-${token}`.slice(0, 64),
    name: `Vendor ${args.label}`
  });
}

export async function createApprovedPurchaseOrder(args: {
  api: E2EApiClient;
  runId: string;
  label: string;
  vendorId: string;
  itemId: string;
  shipToLocationId: string;
  receivingLocationId: string;
  quantity: number;
}): Promise<PurchaseOrder> {
  const token = normalizeToken(`${args.label}-${args.runId}`);
  const today = new Date().toISOString().slice(0, 10);

  return await args.api.post<PurchaseOrder>('/purchase-orders', {
    poNumber: `PO-${token}`.slice(0, 64),
    vendorId: args.vendorId,
    status: 'approved',
    orderDate: today,
    expectedDate: today,
    shipToLocationId: args.shipToLocationId,
    receivingLocationId: args.receivingLocationId,
    lines: [
      {
        lineNumber: 1,
        itemId: args.itemId,
        uom: 'each',
        quantityOrdered: args.quantity,
        // Receipt posting creates FIFO cost layers only when a line unit cost/price is present.
        // QC accept/reject transfers consume those layers from QA.
        unitPrice: 1
      }
    ]
  });
}

export async function postReceipt(args: {
  api: E2EApiClient;
  runId: string;
  purchaseOrderId: string;
  purchaseOrderLineId: string;
  quantity: number;
}): Promise<Receipt> {
  return await args.api.post<Receipt>('/purchase-order-receipts', {
    purchaseOrderId: args.purchaseOrderId,
    receivedAt: new Date().toISOString(),
    idempotencyKey: args.api.nextIdempotencyKey(`receipt-${args.runId}`),
    lines: [
      {
        purchaseOrderLineId: args.purchaseOrderLineId,
        uom: 'each',
        quantityReceived: args.quantity
      }
    ]
  });
}

export async function postQcAccept(args: {
  api: E2EApiClient;
  receiptLineId: string;
  quantity: number;
}): Promise<{ id: string; eventType: string }> {
  return await args.api.post('/qc-events', {
    purchaseOrderReceiptLineId: args.receiptLineId,
    eventType: 'accept',
    quantity: args.quantity,
    uom: 'each',
    actorType: 'user'
  });
}

export async function createAndPostPutaway(args: {
  api: E2EApiClient;
  runId: string;
  receiptId: string;
  receiptLineId: string;
  quantity: number;
  fromLocationId: string;
  toLocationId: string;
}): Promise<Putaway> {
  const created = await createPutawayDraft({
    api: args.api,
    receiptId: args.receiptId,
    receiptLineId: args.receiptLineId,
    quantity: args.quantity,
    fromLocationId: args.fromLocationId,
    toLocationId: args.toLocationId
  });

  return await postPutawayDraft({
    api: args.api,
    runId: args.runId,
    putawayId: created.id
  });
}

export async function createPutawayDraft(args: {
  api: E2EApiClient;
  receiptId: string;
  receiptLineId: string;
  quantity: number;
  fromLocationId: string;
  toLocationId: string;
}): Promise<Putaway> {
  return await args.api.post<Putaway>('/putaways', {
    sourceType: 'purchase_order_receipt',
    purchaseOrderReceiptId: args.receiptId,
    lines: [
      {
        purchaseOrderReceiptLineId: args.receiptLineId,
        fromLocationId: args.fromLocationId,
        toLocationId: args.toLocationId,
        uom: 'each',
        quantity: args.quantity
      }
    ]
  });
}

export async function postPutawayDraft(args: {
  api: E2EApiClient;
  runId: string;
  putawayId: string;
}): Promise<Putaway> {
  return await args.api.post<Putaway>(
    `/putaways/${args.putawayId}/post`,
    {},
    {
      headers: {
        'Idempotency-Key': args.api.nextIdempotencyKey(`putaway-post-${args.runId}`)
      }
    }
  );
}

export async function createSalesOrderSeed(args: {
  api: E2EApiClient;
  runId: string;
  label: string;
  customerId: string;
  warehouseId: string;
  shipFromLocationId: string;
  itemId: string;
  quantity: number;
}): Promise<SalesOrder> {
  const token = normalizeToken(`${args.label}-${args.runId}`);
  return await args.api.post<SalesOrder>('/sales-orders', {
    soNumber: `SO-${token}`.slice(0, 64),
    customerId: args.customerId,
    warehouseId: args.warehouseId,
    status: 'submitted',
    orderDate: new Date().toISOString().slice(0, 10),
    shipFromLocationId: args.shipFromLocationId,
    lines: [
      {
        lineNumber: 1,
        itemId: args.itemId,
        uom: 'each',
        quantityOrdered: args.quantity
      }
    ]
  });
}

export async function createReservationSeed(args: {
  api: E2EApiClient;
  salesOrderLineId: string;
  warehouseId: string;
  itemId: string;
  locationId: string;
  quantity: number;
}): Promise<Reservation> {
  const response = await args.api.post<{ data: Reservation[] }>('/reservations', {
    reservations: [
      {
        demandType: 'sales_order_line',
        demandId: args.salesOrderLineId,
        warehouseId: args.warehouseId,
        itemId: args.itemId,
        locationId: args.locationId,
        uom: 'each',
        quantityReserved: args.quantity
      }
    ]
  });

  const reservation = response.data?.[0];
  return must(reservation, 'Reservation creation did not return data.');
}

export async function allocateReservationSeed(args: {
  api: E2EApiClient;
  runId: string;
  reservationId: string;
  warehouseId: string;
}): Promise<Reservation> {
  return await args.api.post<Reservation>(
    `/reservations/${args.reservationId}/allocate`,
    { warehouseId: args.warehouseId },
    {
      headers: {
        'Idempotency-Key': args.api.nextIdempotencyKey(`allocate-${args.runId}`)
      }
    }
  );
}

export async function cancelReservationSeed(args: {
  api: E2EApiClient;
  runId: string;
  reservationId: string;
  warehouseId: string;
  reason: string;
}): Promise<Reservation> {
  return await args.api.post<Reservation>(
    `/reservations/${args.reservationId}/cancel`,
    {
      warehouseId: args.warehouseId,
      reason: args.reason
    },
    {
      headers: {
        'Idempotency-Key': args.api.nextIdempotencyKey(`cancel-${args.runId}`)
      }
    }
  );
}

export async function createShipmentSeed(args: {
  api: E2EApiClient;
  salesOrderId: string;
  salesOrderLineId: string;
  shipFromLocationId: string;
  quantity: number;
}): Promise<Shipment> {
  return await args.api.post<Shipment>('/shipments', {
    salesOrderId: args.salesOrderId,
    shippedAt: new Date().toISOString(),
    shipFromLocationId: args.shipFromLocationId,
    lines: [
      {
        salesOrderLineId: args.salesOrderLineId,
        uom: 'each',
        quantityShipped: args.quantity
      }
    ]
  });
}

export async function postShipmentSeed(args: {
  api: E2EApiClient;
  runId: string;
  shipmentId: string;
}): Promise<Shipment> {
  return await args.api.post<Shipment>(
    `/shipments/${args.shipmentId}/post`,
    {},
    {
      headers: {
        'Idempotency-Key': args.api.nextIdempotencyKey(`ship-${args.runId}`)
      }
    }
  );
}

export async function postInventoryTransfer(args: {
  api: E2EApiClient;
  runId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  itemId: string;
  quantity: number;
}): Promise<{ movementId: string; transferId: string }> {
  return await args.api.post<{ movementId: string; transferId: string }>('/inventory-transfers', {
    sourceLocationId: args.sourceLocationId,
    destinationLocationId: args.destinationLocationId,
    itemId: args.itemId,
    quantity: args.quantity,
    uom: 'each',
    occurredAt: new Date().toISOString(),
    reasonCode: 'e2e_transfer',
    notes: `E2E transfer ${args.runId}`
  }, {
    headers: {
      'Idempotency-Key': args.api.nextIdempotencyKey(`transfer-${args.runId}`)
    }
  });
}

export async function seedSellableStockViaInbound(args: {
  api: E2EApiClient;
  runId: string;
  label: string;
  quantity: number;
}): Promise<{
  warehouse: WarehouseSeed;
  item: Item;
  vendor: Vendor;
  purchaseOrder: PurchaseOrder;
  receipt: Receipt;
}> {
  const warehouse = await createWarehouseSeed({
    api: args.api,
    runId: args.runId,
    label: `${args.label}-WH`
  });

  const item = await createItemSeed({
    api: args.api,
    runId: args.runId,
    label: `${args.label}-ITEM`,
    defaultLocationId: warehouse.roles.SELLABLE.id,
    requiresQc: true
  });

  const vendor = await createVendorSeed({
    api: args.api,
    runId: args.runId,
    label: `${args.label}-VENDOR`
  });

  const purchaseOrder = await createApprovedPurchaseOrder({
    api: args.api,
    runId: args.runId,
    label: `${args.label}-PO`,
    vendorId: vendor.id,
    itemId: item.id,
    shipToLocationId: warehouse.root.id,
    receivingLocationId: warehouse.roles.QA.id,
    quantity: args.quantity
  });

  const line = must(purchaseOrder.lines?.[0], 'Expected purchase order line was missing.');

  const receipt = await postReceipt({
    api: args.api,
    runId: args.runId,
    purchaseOrderId: purchaseOrder.id,
    purchaseOrderLineId: line.id,
    quantity: args.quantity
  });

  const receiptLine = must(receipt.lines?.[0], 'Expected receipt line was missing.');
  await postQcAccept({ api: args.api, receiptLineId: receiptLine.id, quantity: args.quantity });

  return { warehouse, item, vendor, purchaseOrder, receipt };
}
