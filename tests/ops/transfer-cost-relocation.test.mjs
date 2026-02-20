import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import { stopTestServer } from '../api/helpers/testServer.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `transfer-cost-${randomUUID().slice(0, 8)}`;

async function apiRequest(method, path, { token, body, params, headers } = {}) {
  const url = new URL(baseUrl + path);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  const mergedHeaders = { 'Content-Type': 'application/json', ...(headers ?? {}) };
  if (token) mergedHeaders.Authorization = `Bearer ${token}`;
  const res = await fetch(url.toString(), {
    method,
    headers: mergedHeaders,
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { res, payload };
}

async function getSession() {
  return ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Transfer Cost Relocation Tenant'
  });
}

async function createVendor(token) {
  const code = `V-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/vendors', {
    token,
    body: { code, name: `Vendor ${code}` }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createItem(token, defaultLocationId) {
  const sku = `ITEM-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createReceipt({ token, vendorId, itemId, sellableLocationId, quantity, unitCost }) {
  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId: sellableLocationId,
      receivingLocationId: sellableLocationId,
      expectedDate: new Date().toISOString().slice(0, 10),
      status: 'approved',
      lines: [{ itemId, uom: 'each', quantityOrdered: quantity, unitCost, currencyCode: 'THB' }]
    }
  });
  assert.equal(poRes.res.status, 201, JSON.stringify(poRes.payload));

  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `receipt-${randomUUID()}` },
    body: {
      purchaseOrderId: poRes.payload.id,
      receivedAt: new Date().toISOString(),
      lines: [
        {
          purchaseOrderLineId: poRes.payload.lines[0].id,
          uom: 'each',
          quantityReceived: quantity,
          unitCost
        }
      ]
    }
  });
  assert.equal(receiptRes.res.status, 201, JSON.stringify(receiptRes.payload));
  return receiptRes.payload;
}

async function qcAccept(token, receiptLineId, quantity, actorId) {
  const res = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': `qc-${randomUUID()}` },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity,
      uom: 'each',
      actorType: 'user',
      actorId
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createCustomer(tenantId, db) {
  const id = randomUUID();
  const code = `C-${randomUUID().slice(0, 8)}`;
  await db.query(
    `INSERT INTO customers (id, tenant_id, code, name, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, now(), now())`,
    [id, tenantId, code, `Customer ${code}`]
  );
  return id;
}

async function createSalesOrder(token, { customerId, itemId, quantityOrdered, shipFromLocationId, warehouseId }) {
  const res = await apiRequest('POST', '/sales-orders', {
    token,
    body: {
      soNumber: `SO-${randomUUID().slice(0, 8)}`,
      customerId,
      status: 'submitted',
      warehouseId,
      shipFromLocationId,
      lines: [{ itemId, uom: 'each', quantityOrdered }]
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload;
}

async function createShipment(token, { salesOrderId, salesOrderLineId, shipFromLocationId, quantityShipped }) {
  const res = await apiRequest('POST', '/shipments', {
    token,
    body: {
      salesOrderId,
      shippedAt: new Date().toISOString(),
      shipFromLocationId,
      lines: [{ salesOrderLineId, uom: 'each', quantityShipped }]
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload;
}

test('transfer relocation splits FIFO layers and conserves line costs', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  const actorId = session.user?.id ?? null;
  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const qa = defaults.QA;
  const sellable = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const itemId = await createItem(token, sellable.id);

  await createReceipt({
    token,
    vendorId,
    itemId,
    sellableLocationId: sellable.id,
    quantity: 5,
    unitCost: 5
  });
  const receipt2 = await createReceipt({
    token,
    vendorId,
    itemId,
    sellableLocationId: sellable.id,
    quantity: 10,
    unitCost: 6
  });

  const qcEventId = await qcAccept(token, receipt2.lines[0].id, 7, actorId);
  const linkRes = await db.query(
    `SELECT inventory_movement_id
       FROM qc_inventory_links
      WHERE tenant_id = $1
        AND qc_event_id = $2`,
    [tenantId, qcEventId]
  );
  assert.equal(linkRes.rowCount, 1);
  const transferMovementId = linkRes.rows[0].inventory_movement_id;

  const transferLinks = await db.query(
    `SELECT quantity, unit_cost
       FROM cost_layer_transfer_links
      WHERE tenant_id = $1
        AND transfer_movement_id = $2
      ORDER BY unit_cost ASC`,
    [tenantId, transferMovementId]
  );
  assert.equal(transferLinks.rowCount, 2);
  assert.ok(Math.abs(Number(transferLinks.rows[0].quantity) - 5) < 1e-6);
  assert.ok(Math.abs(Number(transferLinks.rows[0].unit_cost) - 5) < 1e-6);
  assert.ok(Math.abs(Number(transferLinks.rows[1].quantity) - 2) < 1e-6);
  assert.ok(Math.abs(Number(transferLinks.rows[1].unit_cost) - 6) < 1e-6);

  const destLayers = await db.query(
    `SELECT remaining_quantity, unit_cost
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND movement_id = $2
        AND source_type = 'transfer_in'
        AND location_id = $3
      ORDER BY unit_cost ASC`,
    [tenantId, transferMovementId, sellable.id]
  );
  assert.equal(destLayers.rowCount, 2);
  assert.ok(Math.abs(Number(destLayers.rows[0].remaining_quantity) - 5) < 1e-6);
  assert.ok(Math.abs(Number(destLayers.rows[0].unit_cost) - 5) < 1e-6);
  assert.ok(Math.abs(Number(destLayers.rows[1].remaining_quantity) - 2) < 1e-6);
  assert.ok(Math.abs(Number(destLayers.rows[1].unit_cost) - 6) < 1e-6);

  const qaLayers = await db.query(
    `SELECT unit_cost, remaining_quantity
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND source_type = 'receipt'
        AND voided_at IS NULL
      ORDER BY unit_cost ASC`,
    [tenantId, itemId, qa.id]
  );
  assert.equal(qaLayers.rowCount, 2);
  assert.ok(Math.abs(Number(qaLayers.rows[0].unit_cost) - 5) < 1e-6);
  assert.ok(Math.abs(Number(qaLayers.rows[0].remaining_quantity) - 0) < 1e-6);
  assert.ok(Math.abs(Number(qaLayers.rows[1].unit_cost) - 6) < 1e-6);
  assert.ok(Math.abs(Number(qaLayers.rows[1].remaining_quantity) - 8) < 1e-6);

  const movementLines = await db.query(
    `SELECT quantity_delta
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
      ORDER BY quantity_delta ASC`,
    [tenantId, transferMovementId]
  );
  assert.equal(movementLines.rowCount, 2);
  assert.ok(Math.abs(Number(movementLines.rows[0].quantity_delta) + 7) < 1e-6);
  assert.ok(Math.abs(Number(movementLines.rows[1].quantity_delta) - 7) < 1e-6);
});

test('transferred FIFO layers drive downstream shipment COGS at destination', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  const actorId = session.user?.id ?? null;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:cogs` });
  const sellable = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const itemId = await createItem(token, sellable.id);
  await createReceipt({
    token,
    vendorId,
    itemId,
    sellableLocationId: sellable.id,
    quantity: 5,
    unitCost: 4
  });
  const receipt2 = await createReceipt({
    token,
    vendorId,
    itemId,
    sellableLocationId: sellable.id,
    quantity: 10,
    unitCost: 6
  });

  await qcAccept(token, receipt2.lines[0].id, 7, actorId);

  const customerId = await createCustomer(tenantId, db);
  const order = await createSalesOrder(token, {
    customerId,
    itemId,
    quantityOrdered: 6,
    shipFromLocationId: sellable.id,
    warehouseId: warehouse.id
  });
  const shipment = await createShipment(token, {
    salesOrderId: order.id,
    salesOrderLineId: order.lines[0].id,
    shipFromLocationId: sellable.id,
    quantityShipped: 6
  });
  const postRes = await apiRequest('POST', `/shipments/${shipment.id}/post`, {
    token,
    headers: { 'Idempotency-Key': `ship-${randomUUID()}` },
    body: {}
  });
  assert.equal(postRes.res.status, 200, JSON.stringify(postRes.payload));
  const shipmentMovementId = postRes.payload.inventoryMovementId;
  assert.ok(shipmentMovementId);

  const consumption = await db.query(
    `SELECT consumed_quantity, unit_cost, extended_cost
       FROM cost_layer_consumptions
      WHERE tenant_id = $1
        AND movement_id = $2
      ORDER BY unit_cost ASC`,
    [tenantId, shipmentMovementId]
  );
  assert.equal(consumption.rowCount, 2);
  assert.ok(Math.abs(Number(consumption.rows[0].consumed_quantity) - 5) < 1e-6);
  assert.ok(Math.abs(Number(consumption.rows[0].unit_cost) - 4) < 1e-6);
  assert.ok(Math.abs(Number(consumption.rows[1].consumed_quantity) - 1) < 1e-6);
  assert.ok(Math.abs(Number(consumption.rows[1].unit_cost) - 6) < 1e-6);
  const totalCost = consumption.rows.reduce((sum, row) => sum + Number(row.extended_cost), 0);
  assert.ok(Math.abs(totalCost - 26) < 1e-6, `expected shipment cost 26, got ${totalCost}`);
});

test('concurrent shipment posting cannot over-consume a single FIFO layer', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:concurrency` });
  const sellable = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const itemId = await createItem(token, sellable.id);
  await createReceipt({
    token,
    vendorId,
    itemId,
    sellableLocationId: sellable.id,
    quantity: 5,
    unitCost: 9
  });

  const customerId = await createCustomer(tenantId, db);
  const orderA = await createSalesOrder(token, {
    customerId,
    itemId,
    quantityOrdered: 4,
    shipFromLocationId: sellable.id,
    warehouseId: warehouse.id
  });
  const orderB = await createSalesOrder(token, {
    customerId,
    itemId,
    quantityOrdered: 4,
    shipFromLocationId: sellable.id,
    warehouseId: warehouse.id
  });

  const shipmentA = await createShipment(token, {
    salesOrderId: orderA.id,
    salesOrderLineId: orderA.lines[0].id,
    shipFromLocationId: sellable.id,
    quantityShipped: 4
  });
  const shipmentB = await createShipment(token, {
    salesOrderId: orderB.id,
    salesOrderLineId: orderB.lines[0].id,
    shipFromLocationId: sellable.id,
    quantityShipped: 4
  });

  const [postA, postB] = await Promise.all([
    apiRequest('POST', `/shipments/${shipmentA.id}/post`, {
      token,
      headers: { 'Idempotency-Key': `ship-concurrency-a-${randomUUID()}` },
      body: {}
    }),
    apiRequest('POST', `/shipments/${shipmentB.id}/post`, {
      token,
      headers: { 'Idempotency-Key': `ship-concurrency-b-${randomUUID()}` },
      body: {}
    })
  ]);

  for (const response of [postA, postB]) {
    assert.ok(
      response.res.status === 200 || response.res.status === 409,
      `Unexpected shipment post status ${response.res.status}: ${JSON.stringify(response.payload)}`
    );
  }

  const successfulMovementIds = [postA, postB]
    .filter((response) => response.res.status === 200)
    .map((response) => response.payload.inventoryMovementId)
    .filter(Boolean);

  let consumedQty = 0;
  if (successfulMovementIds.length > 0) {
    const consumption = await db.query(
      `SELECT COALESCE(SUM(consumed_quantity), 0) AS qty
         FROM cost_layer_consumptions
        WHERE tenant_id = $1
          AND movement_id = ANY($2::uuid[])`,
      [tenantId, successfulMovementIds]
    );
    consumedQty = Number(consumption.rows[0]?.qty ?? 0);
  }
  assert.ok(consumedQty <= 5 + 1e-6, `Consumed quantity must not exceed available layer quantity (5), got ${consumedQty}`);

  const layerCheck = await db.query(
    `SELECT COALESCE(SUM(remaining_quantity), 0) AS remaining_qty
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND voided_at IS NULL`,
    [tenantId, itemId, sellable.id]
  );
  const remainingQty = Number(layerCheck.rows[0]?.remaining_qty ?? 0);
  assert.ok(remainingQty >= -1e-6, `Remaining quantity must stay non-negative, got ${remainingQty}`);
});

test('transfer reversal is blocked when transferred destination layers were consumed', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  const actorId = session.user?.id ?? null;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:reverse` });
  const sellable = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const itemId = await createItem(token, sellable.id);
  const receipt = await createReceipt({
    token,
    vendorId,
    itemId,
    sellableLocationId: sellable.id,
    quantity: 6,
    unitCost: 5
  });
  const qcEventId = await qcAccept(token, receipt.lines[0].id, 6, actorId);
  const transferRes = await db.query(
    `SELECT inventory_movement_id
       FROM qc_inventory_links
      WHERE tenant_id = $1
        AND qc_event_id = $2`,
    [tenantId, qcEventId]
  );
  assert.equal(transferRes.rowCount, 1);
  const transferMovementId = transferRes.rows[0].inventory_movement_id;

  const adjustmentCreate = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      lines: [
        {
          lineNumber: 1,
          itemId,
          locationId: sellable.id,
          uom: 'each',
          quantityDelta: -1,
          reasonCode: 'consume_after_transfer'
        }
      ]
    }
  });
  assert.equal(adjustmentCreate.res.status, 201, JSON.stringify(adjustmentCreate.payload));
  const adjustmentPost = await apiRequest('POST', `/inventory-adjustments/${adjustmentCreate.payload.id}/post`, {
    token,
    body: {}
  });
  assert.equal(adjustmentPost.res.status, 200, JSON.stringify(adjustmentPost.payload));

  const voidRes = await apiRequest('POST', `/inventory-movements/${transferMovementId}/void-transfer`, {
    token,
    headers: { 'Idempotency-Key': `void-transfer-${randomUUID()}` },
    body: { reason: 'operator_void' }
  });
  assert.equal(voidRes.res.status, 409, JSON.stringify(voidRes.payload));
  const errorMessage = typeof voidRes.payload?.error === 'string'
    ? voidRes.payload.error
    : JSON.stringify(voidRes.payload?.error ?? '');
  assert.match(errorMessage, /consumed/i);
});

test.after(async () => {
  await stopTestServer();
});
