import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import { waitForCondition } from '../api/helpers/waitFor.mjs';

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

function isDescendant(location, warehouseId, byId) {
  let current = location;
  const visited = new Set();
  let depth = 0;
  while (current && current.parentLocationId) {
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    if (current.parentLocationId === warehouseId) return true;
    current = byId.get(current.parentLocationId);
    depth += 1;
    if (depth > 20) return false;
  }
  return false;
}

function formatLocation(location) {
  if (!location) return null;
  return {
    id: location.id,
    code: location.code,
    name: location.name,
    type: location.type,
    role: location.role,
    parentLocationId: location.parentLocationId
  };
}

async function getSession() {
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: 'ATP Expired Lots Tenant'
  });
  db = session.pool;
  return session;
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

async function createItem(token, defaultLocationId) {
  const sku = `EXP-${randomUUID()}`;
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

async function createLot(token, itemId, expiresAt) {
  const res = await apiRequest('POST', '/lots', {
    token,
    body: {
      itemId,
      lotCode: `LOT-${randomUUID()}`,
      status: 'active',
      expiresAt
    }
  });
  assert.equal(res.res.status, 201);
  return res.payload.id;
}

async function createAdjustmentWithLots(token, itemId, locationId, quantity, allocations) {
  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      reasonCode: 'seed',
      lines: [
        {
          lineNumber: 1,
          itemId,
          locationId,
          uom: 'each',
          quantityDelta: quantity,
          reasonCode: 'seed'
        }
      ]
    }
  });
  assert.equal(adjustmentRes.res.status, 201);
  const postRes = await apiRequest('POST', `/inventory-adjustments/${adjustmentRes.payload.id}/post`, { token });
  assert.equal(postRes.res.status, 200);
  const movementId = postRes.payload.inventoryMovementId;
  const linesRes = await apiRequest('GET', `/inventory-movements/${movementId}/lines`, { token });
  assert.equal(linesRes.res.status, 200);
  const lineId = linesRes.payload.data[0]?.id;
  assert.ok(lineId);

  const lotAllocRes = await apiRequest('POST', `/inventory-movement-lines/${lineId}/lots`, {
    token,
    body: { allocations }
  });
  assert.equal(lotAllocRes.res.status, 201);
  return { movementId, lineId };
}

async function getAtpDetail(token, itemId, locationId, { allowNotFound = false } = {}) {
  const res = await apiRequest('GET', '/atp/detail', {
    token,
    params: { itemId, locationId }
  });
  if (allowNotFound && res.res.status === 404) return null;
  assert.equal(res.res.status, 200);
  return res.payload.data;
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
  return soRes.payload;
}

async function getLineBackorder(token, orderId) {
  const res = await apiRequest('GET', `/sales-orders/${orderId}`, { token });
  assert.equal(res.res.status, 200);
  return Number(res.payload.lines[0]?.derivedBackorderQty ?? 0);
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
        { itemId, uom: 'each', quantityOrdered: quantity, unitCost: 5, currencyCode: 'THB' }
      ]
    }
  });
  assert.equal(poRes.res.status, 201);
  const poId = poRes.payload.id;
  const poLineId = poRes.payload.lines[0].id;

  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `receipt-${randomUUID()}` },
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
  return res.payload.id;
}

test('ATP excludes expired lots from sellable on-hand', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token && tenantId);

  const { defaults } = await ensureStandardWarehouse({ token, tenantId, apiRequest, scope: import.meta.url});
  const sellable = defaults.SELLABLE;
  const itemId = await createItem(token, sellable.id);
  const expiredAt = new Date(Date.now() - 86400000).toISOString();
  const validAt = new Date(Date.now() + 86400000).toISOString();
  const expiredLotId = await createLot(token, itemId, expiredAt);
  const validLotId = await createLot(token, itemId, validAt);

  await createAdjustmentWithLots(token, itemId, sellable.id, 10, [
    { lotId: expiredLotId, uom: 'each', quantityDelta: '4' },
    { lotId: validLotId, uom: 'each', quantityDelta: '6' }
  ]);

  const atp = await waitForCondition(
    () => getAtpDetail(token, itemId, sellable.id),
    (value) => value && Math.abs(Number(value.onHand) - 6) < 1e-6,
    { label: 'atp onHand after lots adjustment' }
  );
  assert.ok(atp);
  assert.ok(Math.abs(Number(atp.onHand) - 6) < 1e-6, `Expected onHand 6, got ${atp.onHand}`);
  assert.ok(Math.abs(Number(atp.availableToPromise) - 6) < 1e-6);
});

test('QC accept into sellable for expired lot stays excluded from ATP', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const userId = session.user?.id;
  assert.ok(token && tenantId && userId);

  const { defaults } = await ensureStandardWarehouse({ token, tenantId, apiRequest, scope: import.meta.url});
  const sellable = defaults.SELLABLE;
  const vendorRes = await apiRequest('POST', '/vendors', {
    token,
    body: { code: `V-${randomUUID()}`, name: 'Vendor' }
  });
  assert.equal(vendorRes.res.status, 201);
  const itemId = await createItem(token, sellable.id);
  const expiredAt = new Date(Date.now() - 86400000).toISOString();
  const expiredLotId = await createLot(token, itemId, expiredAt);

  const receiptLineId = await receiveIntoQa(token, vendorRes.payload.id, itemId, sellable.id, 10);
  const qcEventId = await qcAccept(token, receiptLineId, 10, userId);

  const linkRes = await db.query(
    `SELECT inventory_movement_id FROM qc_inventory_links WHERE tenant_id = $1 AND qc_event_id = $2`,
    [tenantId, qcEventId]
  );
  const movementId = linkRes.rows[0]?.inventory_movement_id;
  assert.ok(movementId);
  const linesRes = await apiRequest('GET', `/inventory-movements/${movementId}/lines`, { token });
  assert.equal(linesRes.res.status, 200);
  const inboundLine = linesRes.payload.data.find((line) => line.locationId === sellable.id);
  assert.ok(inboundLine);

  const allocRes = await apiRequest('POST', `/inventory-movement-lines/${inboundLine.id}/lots`, {
    token,
    body: { allocations: [{ lotId: expiredLotId, uom: 'each', quantityDelta: '10' }] }
  });
  assert.equal(allocRes.res.status, 201);

  const atp = await waitForCondition(
    () => getAtpDetail(token, itemId, sellable.id, { allowNotFound: true }),
    (value) => value === null,
    { label: 'atp excludes expired lot after qc accept' }
  );
  assert.equal(atp, null);
});

test('Derived backorder ignores expired lots', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token && tenantId);

  const { defaults } = await ensureStandardWarehouse({ token, tenantId, apiRequest, scope: import.meta.url});
  const sellable = defaults.SELLABLE;
  const customerId = await createCustomer(tenantId);
  const itemId = await createItem(token, sellable.id);
  const expiredAt = new Date(Date.now() - 86400000).toISOString();
  const expiredLotId = await createLot(token, itemId, expiredAt);

  await createAdjustmentWithLots(token, itemId, sellable.id, 10, [
    { lotId: expiredLotId, uom: 'each', quantityDelta: '10' }
  ]);

  const order = await createSalesOrder(token, customerId, itemId, 5, sellable.id);
  const backorder = await getLineBackorder(token, order.id);
  assert.ok(Math.abs(backorder - 5) < 1e-6, `Expected backorder 5, got ${backorder}`);
});
