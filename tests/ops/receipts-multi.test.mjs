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
const tenantSlug = `receipts-multi-${randomUUID().slice(0, 8)}`;
let db;

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
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Receipts Multi Tenant'
  });
  db = session.pool;
  return session;
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

async function createPurchaseOrder(token, vendorId, shipToLocationId, lines) {
  const today = new Date().toISOString().slice(0, 10);
  const res = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId,
      receivingLocationId: shipToLocationId,
      expectedDate: today,
      status: 'approved',
      lines
    }
  });
  assert.equal(res.res.status, 201);
  return res.payload;
}

async function createReceipt(token, poId, lines) {
  const res = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `receipt-${randomUUID()}` },
    body: {
      purchaseOrderId: poId,
      receivedAt: new Date().toISOString(),
      lines
    }
  });
  assert.ok(
    res.res.status === 200 || res.res.status === 201,
    `Receipt failed: status=${res.res.status} body=${JSON.stringify(res.payload)}`
  );
  return res.payload;
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

test('multiple receipt lines for same SKU aggregate correctly', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const userId = session.user?.id;
  assert.ok(token);
  assert.ok(tenantId);
  assert.ok(userId);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const qaLocation = defaults.QA;
  const sellableLocation = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const itemId = await createItem(token, sellableLocation.id);

  const po = await createPurchaseOrder(token, vendorId, sellableLocation.id, [
    { itemId, uom: 'each', quantityOrdered: 5, unitCost: 5, currencyCode: 'THB' },
    { itemId, uom: 'each', quantityOrdered: 7, unitCost: 5, currencyCode: 'THB' }
  ]);

  const receipt = await createReceipt(token, po.id, [
    { purchaseOrderLineId: po.lines[0].id, uom: 'each', quantityReceived: 5, unitCost: 5 },
    { purchaseOrderLineId: po.lines[1].id, uom: 'each', quantityReceived: 7, unitCost: 5 }
  ]);

  const receiptLineIds = receipt.lines.map((line) => line.id);
  for (const receiptLineId of receiptLineIds) {
    const countRes = await db.query(
      `SELECT COUNT(*) AS count
         FROM inventory_cost_layers
        WHERE tenant_id = $1
          AND source_type = 'receipt'
          AND source_document_id = $2`,
      [tenantId, receiptLineId]
    );
    assert.equal(Number(countRes.rows[0].count), 1);
  }

  await expectSnapshotEventuallyMatchesLedger({
    db,
    apiRequest,
    token,
    tenantId,
    itemId,
    locationId: qaLocation.id,
    label: 'qa snapshot after multi-line receipt'
  });

  for (const line of receipt.lines) {
    await qcAccept(token, line.id, Number(line.quantityReceived), userId);
  }

  await expectSnapshotEventuallyMatchesLedger({
    db,
    apiRequest,
    token,
    tenantId,
    itemId,
    locationId: qaLocation.id,
    label: 'qa snapshot after qc accept multi-line'
  });

  await expectSnapshotEventuallyMatchesLedger({
    db,
    apiRequest,
    token,
    tenantId,
    itemId,
    locationId: sellableLocation.id,
    label: 'sellable snapshot after qc accept multi-line'
  });

  const costRes = await db.query(
    `SELECT COUNT(*) AS count
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND source_type = 'receipt'
        AND source_document_id = ANY($2::uuid[])`,
    [tenantId, receiptLineIds]
  );
  assert.equal(Number(costRes.rows[0].count), receiptLineIds.length);
});

test('partial receipts over time reconcile correctly', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const userId = session.user?.id;
  assert.ok(token);
  assert.ok(tenantId);
  assert.ok(userId);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const qaLocation = defaults.QA;
  const sellableLocation = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const itemId = await createItem(token, sellableLocation.id);

  const po = await createPurchaseOrder(token, vendorId, sellableLocation.id, [
    { itemId, uom: 'each', quantityOrdered: 4, unitCost: 5, currencyCode: 'THB' },
    { itemId, uom: 'each', quantityOrdered: 6, unitCost: 5, currencyCode: 'THB' }
  ]);

  const receipt1 = await createReceipt(token, po.id, [
    { purchaseOrderLineId: po.lines[0].id, uom: 'each', quantityReceived: 4, unitCost: 5 }
  ]);

  await expectSnapshotEventuallyMatchesLedger({
    db,
    apiRequest,
    token,
    tenantId,
    itemId,
    locationId: qaLocation.id,
    label: 'qa snapshot after first receipt'
  });

  const receipt2 = await createReceipt(token, po.id, [
    { purchaseOrderLineId: po.lines[1].id, uom: 'each', quantityReceived: 6, unitCost: 5 }
  ]);

  await expectSnapshotEventuallyMatchesLedger({
    db,
    apiRequest,
    token,
    tenantId,
    itemId,
    locationId: qaLocation.id,
    label: 'qa snapshot after second receipt'
  });

  await qcAccept(token, receipt1.lines[0].id, Number(receipt1.lines[0].quantityReceived), userId);
  await qcAccept(token, receipt2.lines[0].id, Number(receipt2.lines[0].quantityReceived), userId);

  await expectSnapshotEventuallyMatchesLedger({
    db,
    apiRequest,
    token,
    tenantId,
    itemId,
    locationId: qaLocation.id,
    label: 'qa snapshot after qc accept partial receipts'
  });

  await expectSnapshotEventuallyMatchesLedger({
    db,
    apiRequest,
    token,
    tenantId,
    itemId,
    locationId: sellableLocation.id,
    label: 'sellable snapshot after qc accept partial receipts'
  });

  const receiptLineIds = [receipt1.lines[0].id, receipt2.lines[0].id];
  const costRes = await db.query(
    `SELECT COUNT(*) AS count
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND source_type = 'receipt'
        AND source_document_id = ANY($2::uuid[])`,
    [tenantId, receiptLineIds]
  );
  assert.equal(Number(costRes.rows[0].count), receiptLineIds.length);
});
