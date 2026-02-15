import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import { expectSnapshotEventuallyMatchesLedger } from '../helpers/expectSnapshotEventuallyMatchesLedger.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `receipts-cross-${randomUUID().slice(0, 8)}`;

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
    tenantName: 'Receipts Cross Warehouse Tenant'
  });
}

async function createVendor(token) {
  const code = `V-${randomUUID()}`;
  const res = await apiRequest('POST', '/vendors', {
    token,
    body: { code, name: `Vendor ${code}` }
  });
  assert.equal(res.res.status, 201);
  return res.payload.id;
}

async function createItem(token, defaultLocationId) {
  const sku = `ITEM-${randomUUID()}`;
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
  assert.equal(res.res.status, 201);
  return res.payload.id;
}

async function createWarehouseRoot(token, label) {
  const body = {
    code: `WH-${label}-${randomUUID().slice(0, 8)}`,
    name: `Warehouse ${label}`,
    type: 'warehouse',
    role: null,
    isSellable: false,
    parentLocationId: null,
    active: true
  };
  const res = await apiRequest('POST', '/locations', { token, body });
  assert.equal(res.res.status, 201);
  return res.payload;
}

async function createRoleBin(token, warehouseId, role, isSellable) {
  const body = {
    code: `${role}-${randomUUID().slice(0, 8)}`,
    name: `${role} ${randomUUID().slice(0, 4)}`,
    type: 'bin',
    role,
    isSellable,
    parentLocationId: warehouseId,
    active: true
  };
  const res = await apiRequest('POST', '/locations', { token, body });
  assert.equal(res.res.status, 201);
  return res.payload;
}

async function createPurchaseOrder(token, vendorId, shipToLocationId, itemId, quantity) {
  const today = new Date().toISOString().slice(0, 10);
  const res = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId,
      receivingLocationId: shipToLocationId,
      expectedDate: today,
      status: 'approved',
      lines: [
        {
          itemId,
          uom: 'each',
          quantityOrdered: quantity,
          unitCost: 5,
          currencyCode: 'THB'
        }
      ]
    }
  });
  assert.equal(res.res.status, 201);
  return res.payload;
}

async function createReceipt(token, poId, poLineId, quantity) {
  const res = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `receipt-${randomUUID()}` },
    body: {
      purchaseOrderId: poId,
      receivedAt: new Date().toISOString(),
      lines: [{ purchaseOrderLineId: poLineId, uom: 'each', quantityReceived: quantity, unitCost: 5 }]
    }
  });
  assert.equal(res.res.status, 201);
  return res.payload.lines[0].id;
}

async function qcAccept(token, receiptLineId, quantity, actorId) {
  const res = await apiRequest('POST', '/qc-events', {
    token,
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity,
      uom: 'each',
      actorType: 'user',
      actorId
    }
  });
  assert.equal(res.res.status, 201);
}

test('receipts and QC are isolated across warehouses', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const userId = session.user?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const qaA = defaults.QA;
  const sellableA = defaults.SELLABLE;

  const warehouseB = await createWarehouseRoot(token, 'B');
  const qaB = await createRoleBin(token, warehouseB.id, 'QA', false);
  const sellableB = await createRoleBin(token, warehouseB.id, 'SELLABLE', true);

  const vendorId = await createVendor(token);
  const itemId = await createItem(token, sellableA.id);

  const po = await createPurchaseOrder(token, vendorId, sellableA.id, itemId, 5);
  const receiptLineId = await createReceipt(token, po.id, po.lines[0].id, 5);

  await expectSnapshotEventuallyMatchesLedger({
    db: session.pool,
    apiRequest,
    token,
    tenantId,
    itemId,
    locationId: qaA.id,
    label: 'warehouse A QA after receipt'
  });

  await expectSnapshotEventuallyMatchesLedger({
    db: session.pool,
    apiRequest,
    token,
    tenantId,
    itemId,
    locationId: qaB.id,
    label: 'warehouse B QA remains 0'
  });

  await qcAccept(token, receiptLineId, 5, userId);

  await expectSnapshotEventuallyMatchesLedger({
    db: session.pool,
    apiRequest,
    token,
    tenantId,
    itemId,
    locationId: sellableA.id,
    label: 'warehouse A sellable after QC'
  });

  await expectSnapshotEventuallyMatchesLedger({
    db: session.pool,
    apiRequest,
    token,
    tenantId,
    itemId,
    locationId: sellableB.id,
    label: 'warehouse B sellable remains 0'
  });
});
