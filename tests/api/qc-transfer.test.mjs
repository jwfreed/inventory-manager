import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = process.env.SEED_TENANT_SLUG || 'default';

function createPool() {
  return new Pool({ connectionString: process.env.DATABASE_URL });
}

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
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { res, payload };
}

async function ensureSession() {
  const login = await apiRequest('POST', '/auth/login', {
    body: { email: adminEmail, password: adminPassword, tenantSlug },
  });
  if (login.res.status === 200) return login.payload;
  const bootstrap = await apiRequest('POST', '/auth/bootstrap', {
    body: { adminEmail, adminPassword, tenantSlug, tenantName: 'QC Transfer Test Tenant' },
  });
  assert.equal(bootstrap.res.status === 201 || bootstrap.res.status === 409, true);
  const retry = await apiRequest('POST', '/auth/login', {
    body: { email: adminEmail, password: adminPassword, tenantSlug },
  });
  assert.equal(retry.res.status, 200);
  return retry.payload;
}

async function ensureWarehouse(token, tenantId, pool) {
  await apiRequest('POST', '/locations/templates/standard-warehouse', {
    token,
    body: { includeReceivingQc: true },
  });
  const locationsRes = await apiRequest('GET', '/locations', { token });
  assert.equal(locationsRes.res.status, 200);
  const warehouse = locationsRes.payload.data.find((loc) => loc.type === 'warehouse');
  assert.ok(warehouse, 'Warehouse required');
  const defaultsRes = await pool.query(
    `SELECT role, location_id FROM warehouse_default_location WHERE tenant_id = $1 AND warehouse_id = $2`,
    [tenantId, warehouse.id]
  );
  const defaults = new Map(defaultsRes.rows.map((r) => [r.role, r.location_id]));
  const qaLocationId = defaults.get('QA');
  const sellableLocationId = defaults.get('SELLABLE');
  const holdLocationId = defaults.get('HOLD');
  assert.ok(qaLocationId, 'QA default required');
  assert.ok(sellableLocationId, 'SELLABLE default required');
  assert.ok(holdLocationId, 'HOLD default required');
  return { warehouse, qaLocationId, sellableLocationId, holdLocationId };
}

async function createVendor(token) {
  const vendorCode = `V-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const vendorRes = await apiRequest('POST', '/vendors', {
    token,
    body: { code: vendorCode, name: `Vendor ${vendorCode}` },
  });
  assert.equal(vendorRes.res.status, 201);
  return vendorRes.payload.id;
}

async function createItem(token, sellableLocationId) {
  const sku = `ITEM-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: sellableLocationId
    }
  });
  assert.equal(itemRes.res.status, 201);
  return itemRes.payload.id;
}

async function createReceipt({ token, vendorId, itemId, sellableLocationId, quantity = 10 }) {
  const today = new Date().toISOString().slice(0, 10);
  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId: sellableLocationId,
      receivingLocationId: sellableLocationId,
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
  assert.equal(poRes.res.status, 201);
  const poId = poRes.payload.id;
  const poLineId = poRes.payload.lines[0].id;

  const idempotencyKey = `receipt-${randomUUID()}`;
  const receivedAt = new Date().toISOString();
  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      purchaseOrderId: poId,
      receivedAt,
      lines: [{ purchaseOrderLineId: poLineId, uom: 'each', quantityReceived: quantity, unitCost: 5 }]
    }
  });
  assert.equal(receiptRes.res.status, 201);
  return receiptRes.payload;
}

test('QC accept retry is idempotent and does not create extra cost layers', async (t) => {
  const pool = createPool();
  t.after(async () => {
    await pool.end();
  });

  const session = await ensureSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { qaLocationId, sellableLocationId } = await ensureWarehouse(token, tenantId, pool);
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, sellableLocationId);
  const receipt = await createReceipt({ token, vendorId, itemId, sellableLocationId, quantity: 10 });
  const receiptLineId = receipt.lines[0].id;

  const costRes1 = await pool.query(
    `SELECT COUNT(*) AS count
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND source_type = 'receipt'
        AND source_document_id = $2`,
    [tenantId, receiptLineId]
  );
  assert.equal(Number(costRes1.rows[0].count), 1);

  const qcKey = `qc-${randomUUID()}`;
  const qcRes = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': qcKey },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity: 10,
      uom: 'each',
      actorType: 'user',
      actorId: session.user?.id
    }
  });
  assert.equal(qcRes.res.status, 201);

  const qcRes2 = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': qcKey },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity: 10,
      uom: 'each',
      actorType: 'user',
      actorId: session.user?.id
    }
  });
  assert.equal(qcRes2.res.status, 200);
  assert.equal(qcRes2.payload.id, qcRes.payload.id);

  const movementRes = await pool.query(
    `SELECT COUNT(*) AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = 'qc_event'
        AND source_id = $2
        AND movement_type = 'transfer'`,
    [tenantId, qcRes.payload.id]
  );
  assert.equal(Number(movementRes.rows[0].count), 1);

  const costRes2 = await pool.query(
    `SELECT COUNT(*) AS count
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND source_type = 'receipt'
        AND source_document_id = $2`,
    [tenantId, receiptLineId]
  );
  assert.equal(Number(costRes2.rows[0].count), 1);

  const qaSnapshot = await apiRequest('GET', '/inventory-snapshot', {
    token,
    params: { itemId, locationId: qaLocationId }
  });
  assert.equal(qaSnapshot.res.status, 200);
  assert.ok(Math.abs(Number(qaSnapshot.payload.data?.[0]?.onHand ?? 0)) < 1e-6);
});

test('QC partial split routes to accept and hold without new cost layers', async (t) => {
  const pool = createPool();
  t.after(async () => {
    await pool.end();
  });

  const session = await ensureSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { qaLocationId, sellableLocationId, holdLocationId } = await ensureWarehouse(token, tenantId, pool);
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, sellableLocationId);
  const receipt = await createReceipt({ token, vendorId, itemId, sellableLocationId, quantity: 10 });
  const receiptLineId = receipt.lines[0].id;

  const acceptRes = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': `qc-accept-${randomUUID()}` },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity: 6,
      uom: 'each',
      actorType: 'user',
      actorId: session.user?.id
    }
  });
  assert.equal(acceptRes.res.status, 201);

  const holdRes = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': `qc-hold-${randomUUID()}` },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'hold',
      quantity: 4,
      uom: 'each',
      actorType: 'user',
      actorId: session.user?.id
    }
  });
  assert.equal(holdRes.res.status, 201);

  const qaSnapshot = await apiRequest('GET', '/inventory-snapshot', {
    token,
    params: { itemId, locationId: qaLocationId }
  });
  assert.equal(qaSnapshot.res.status, 200);
  assert.ok(Math.abs(Number(qaSnapshot.payload.data?.[0]?.onHand ?? 0)) < 1e-6);

  const sellableSnapshot = await apiRequest('GET', '/inventory-snapshot', {
    token,
    params: { itemId, locationId: sellableLocationId }
  });
  assert.equal(sellableSnapshot.res.status, 200);
  assert.ok(Math.abs(Number(sellableSnapshot.payload.data?.[0]?.onHand ?? 0) - 6) < 1e-6);

  const holdSnapshot = await apiRequest('GET', '/inventory-snapshot', {
    token,
    params: { itemId, locationId: holdLocationId }
  });
  assert.equal(holdSnapshot.res.status, 200);
  assert.ok(Math.abs(Number(holdSnapshot.payload.data?.[0]?.onHand ?? 0) - 4) < 1e-6);
});

test('QC validation failures produce no side effects', async (t) => {
  const pool = createPool();
  t.after(async () => {
    await pool.end();
  });

  const session = await ensureSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { qaLocationId, sellableLocationId, holdLocationId, warehouse } = await ensureWarehouse(
    token,
    tenantId,
    pool
  );
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, sellableLocationId);
  const receipt = await createReceipt({ token, vendorId, itemId, sellableLocationId, quantity: 10 });
  const receiptLineId = receipt.lines[0].id;

  const adjustRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      lines: [
        { lineNumber: 1, itemId, locationId: qaLocationId, uom: 'each', quantityDelta: -8, reasonCode: 'test' }
      ]
    }
  });
  assert.equal(adjustRes.res.status, 201);
  const adjustPost = await apiRequest('POST', `/inventory-adjustments/${adjustRes.payload.id}/post`, { token });
  assert.equal(adjustPost.res.status, 200);

  const insufficientRes = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': `qc-insufficient-${randomUUID()}` },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity: 5,
      uom: 'each',
      actorType: 'user',
      actorId: session.user?.id
    }
  });
  assert.equal(insufficientRes.res.status, 409);

  const defaultsBefore = await pool.query(
    `SELECT location_id FROM warehouse_default_location
      WHERE tenant_id = $1 AND warehouse_id = $2 AND role = 'SELLABLE'`,
    [tenantId, warehouse.id]
  );
  const originalSellableId = defaultsBefore.rows[0]?.location_id;
  assert.ok(originalSellableId);
  const mismatchLocationRes = await apiRequest('POST', '/locations', {
    token,
    body: {
      code: `HOLD-MISMATCH-${randomUUID().slice(0, 8)}`,
      name: 'Hold Mismatch',
      type: 'bin',
      parentLocationId: warehouse.id,
      role: 'HOLD',
      isSellable: false
    }
  });
  assert.equal(mismatchLocationRes.res.status, 201);
  const mismatchLocationId = mismatchLocationRes.payload.id;
  await pool.query(
    `UPDATE warehouse_default_location
        SET location_id = $1
      WHERE tenant_id = $2 AND warehouse_id = $3 AND role = 'SELLABLE'`,
    [mismatchLocationId, tenantId, warehouse.id]
  );

  const mismatchRes = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': `qc-mismatch-${randomUUID()}` },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity: 1,
      uom: 'each',
      actorType: 'user',
      actorId: session.user?.id
    }
  });
  assert.equal(mismatchRes.res.status, 400);

  await pool.query(
    `UPDATE warehouse_default_location
        SET location_id = $1
      WHERE tenant_id = $2 AND warehouse_id = $3 AND role = 'SELLABLE'`,
    [originalSellableId, tenantId, warehouse.id]
  );
});
