import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSession } from './helpers/ensureSession.mjs';
import { waitForCondition } from './helpers/waitFor.mjs';
import { ensureStandardWarehouse } from './helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = process.env.SEED_TENANT_SLUG || 'default';
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

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function assertOk(res, label, payload, requestBody, allowed = [200, 201]) {
  if (!allowed.includes(res.status)) {
    const body = typeof payload === 'string' ? payload : safeJson(payload);
    const req = requestBody ? safeJson(requestBody) : '';
    throw new Error(`BOOTSTRAP_FAILED ${label} status=${res.status} body=${body}${req ? ` request=${req}` : ''}`);
  }
}


async function getSession() {
  const session = await ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: 'Backorder Derived Tenant'
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

async function createCustomer(tenantId) {
  const id = randomUUID();
  const code = `C-${randomUUID()}`;
  await db.query(
    `INSERT INTO customers (id, tenant_id, code, name, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, now(), now())`,
    [id, tenantId, code, `Customer ${code}`]
  );
  return id;
}

async function createItem(token, sellableLocationId) {
  const sku = `BO-${randomUUID()}`;
  const res = await apiRequest('POST', '/items', {
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
  assert.equal(res.res.status, 201);
  return res.payload.id;
}

async function createSalesOrder(token, customerId, itemId, quantity, shipFromLocationId) {
  const soRes = await apiRequest('POST', '/sales-orders', {
    token,
    body: {
      soNumber: `SO-${randomUUID()}`,
      customerId,
      status: 'submitted',
      shipFromLocationId,
      lines: [{ itemId, uom: 'each', quantityOrdered: quantity }]
    }
  });
  assert.equal(soRes.res.status, 201);
  return { orderId: soRes.payload.id, lineId: soRes.payload.lines[0].id };
}

async function getLineBackorder(token, orderId) {
  const res = await apiRequest('GET', `/sales-orders/${orderId}`, { token });
  assert.equal(res.res.status, 200);
  const line = res.payload.lines[0];
  return Number(line.derivedBackorderQty ?? 0);
}

async function receiveIntoQa(token, vendorId, itemId, shipToLocationId, quantity) {
  const today = new Date().toISOString().slice(0, 10);
  const poRes = await apiRequest('POST', '/purchase-orders', {
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
  assert.equal(poRes.res.status, 201);
  const poId = poRes.payload.id;
  const poLineId = poRes.payload.lines[0].id;

  const idempotencyKey = `receipt-${randomUUID()}`;
  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      purchaseOrderId: poId,
      receivedAt: new Date().toISOString(),
      lines: [{ purchaseOrderLineId: poLineId, uom: 'each', quantityReceived: quantity, unitCost: 5 }]
    }
  });
  assert.equal(receiptRes.res.status, 201);
  return receiptRes.payload.lines[0].id;
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

async function createReservation(token, lineId, itemId, locationId, quantity) {
  const res = await apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `res-${randomUUID()}` },
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: lineId,
          itemId,
          locationId,
          uom: 'each',
          quantityReserved: quantity
        }
      ]
    }
  });
  assert.equal(res.res.status, 201);
  return res.payload.data[0].id;
}

async function cancelReservation(token, reservationId) {
  const res = await apiRequest('POST', `/reservations/${reservationId}/cancel`, {
    token,
    headers: { 'Idempotency-Key': `cancel-${randomUUID()}` },
    body: { reason: 'test' }
  });
  assert.equal(res.res.status, 200);
}

test('Derived backorder tracks sellable supply and commitments', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const userId = session.user?.id;
  assert.ok(token);
  assert.ok(tenantId);
  assert.ok(userId);

  const { defaults } = await ensureStandardWarehouse({ token, tenantId, apiRequest, scope: import.meta.url});
  const qa = defaults.QA;
  const sellable = defaults.SELLABLE;
  const vendorId = await createVendor(token);
  const customerId = await createCustomer(tenantId);
  const itemId = await createItem(token, sellable.id);
  const { orderId, lineId } = await createSalesOrder(token, customerId, itemId, 10, sellable.id);

  const initialBackorder = await getLineBackorder(token, orderId);
  assert.ok(Math.abs(initialBackorder - 10) < 1e-6);

  const receiptLineId = await receiveIntoQa(token, vendorId, itemId, sellable.id, 10);
  const afterQaReceipt = await waitForCondition(
    () => getLineBackorder(token, orderId),
    (value) => Math.abs(value - 10) < 1e-6,
    { label: 'backorder after QA receipt' }
  );
  assert.ok(Math.abs(afterQaReceipt - 10) < 1e-6, `Expected backorder unchanged after QA receipt`);

  await qcAccept(token, receiptLineId, 10, userId);
  const afterQcAccept = await waitForCondition(
    () => getLineBackorder(token, orderId),
    (value) => Math.abs(value) < 1e-6,
    { label: 'backorder after QC accept' }
  );
  assert.ok(Math.abs(afterQcAccept) < 1e-6, `Expected backorder to clear after QC accept`);

  const reservationId = await createReservation(token, lineId, itemId, sellable.id, 2);
  const afterReserve = await waitForCondition(
    () => getLineBackorder(token, orderId),
    (value) => Math.abs(value - 2) < 1e-6,
    { label: 'backorder after reserve' }
  );
  assert.ok(Math.abs(afterReserve - 2) < 1e-6, `Expected backorder to increase after reservation`);

  await cancelReservation(token, reservationId);
  const afterCancel = await waitForCondition(
    () => getLineBackorder(token, orderId),
    (value) => Math.abs(value) < 1e-6,
    { label: 'backorder after cancel' }
  );
  assert.ok(Math.abs(afterCancel) < 1e-6, `Expected backorder to return to 0 after cancel`);
});
