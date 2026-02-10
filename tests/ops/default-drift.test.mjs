import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
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
    body: body ? JSON.stringify(body) : undefined,
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

function formatLocation(location) {
  if (!location) return null;
  return {
    id: location.id,
    code: location.code,
    name: location.name,
    type: location.type,
    role: location.role,
    parentLocationId: location.parentLocationId,
  };
}

async function getSession(tenantSlug) {
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: `Default Drift ${tenantSlug}`
  });
  db = session.pool;
  return session;
}

async function setWarehouseDefault({ tenantId, warehouseId, role, locationId }) {
  await db.query(
    `DELETE FROM warehouse_default_location
      WHERE tenant_id = $1 AND warehouse_id = $2 AND role = $3`,
    [tenantId, warehouseId, role]
  );
  await db.query(
    `INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, warehouseId, role, locationId]
  );
  const verify = await db.query(
    `SELECT location_id FROM warehouse_default_location WHERE tenant_id = $1 AND warehouse_id = $2 AND role = $3`,
    [tenantId, warehouseId, role]
  );
  if (verify.rowCount !== 1 || verify.rows[0].location_id !== locationId) {
    throw new Error(`DEFAULT_SET_FAILED role=${role} tenantId=${tenantId} warehouseId=${warehouseId} locationId=${locationId}`);
  }
}

async function createWarehouseGraph(token) {
  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const qaLocation = defaults.QA;
  const sellableA = defaults.SELLABLE;

  const tempBody = {
    code: `BIN-${randomUUID().slice(0, 8)}`,
    name: 'Sellable B',
    type: 'bin',
    role: null,
    isSellable: false,
    parentLocationId: sellableA.id,
  };
  const tempRes = await apiRequest('POST', '/locations', { token, body: tempBody });
  assertOk(tempRes.res, 'POST /locations (temp bin)', tempRes.payload, tempBody, [201]);

  const updateBody = {
    code: tempRes.payload.code,
    name: tempRes.payload.name,
    type: tempRes.payload.type,
    role: 'SELLABLE',
    isSellable: true,
    parentLocationId: tempRes.payload.parentLocationId
  };
  const updateRes = await apiRequest('PUT', `/locations/${tempRes.payload.id}`, { token, body: updateBody });
  assertOk(updateRes.res, 'PUT /locations (sellable B)', updateRes.payload, updateBody, [200]);

  const sellableB = updateRes.payload;
  return { warehouse, qaLocation, sellableA, sellableB };
}

async function createItem(token, defaultLocationId) {
  const sku = `DEF-${randomUUID().slice(0, 8)}`;
  const body = {
    sku,
    name: `Default Drift Item ${sku}`,
    uomDimension: 'count',
    canonicalUom: 'each',
    stockingUom: 'each',
    defaultLocationId,
  };
  const res = await apiRequest('POST', '/items', { token, body });
  assertOk(res.res, 'POST /items', res.payload, body, [201]);
  return res.payload.id;
}

async function receiveIntoQa(token, vendorId, itemId, qaLocationId, quantity) {
  const today = new Date().toISOString().slice(0, 10);
  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId: qaLocationId,
      receivingLocationId: qaLocationId,
      expectedDate: today,
      status: 'approved',
      lines: [{ itemId, uom: 'each', quantityOrdered: quantity, unitCost: 5, currencyCode: 'THB' }],
    },
  });
  assertOk(poRes.res, 'POST /purchase-orders', poRes.payload, { itemId, qaLocationId }, [201]);

  const poId = poRes.payload.id;
  const poLineId = poRes.payload.lines[0].id;
  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `receipt-${randomUUID()}` },
    body: {
      purchaseOrderId: poId,
      receivedAt: new Date().toISOString(),
      lines: [{ purchaseOrderLineId: poLineId, uom: 'each', quantityReceived: quantity, unitCost: 5 }],
    },
  });
  assertOk(receiptRes.res, 'POST /purchase-order-receipts', receiptRes.payload, { poId }, [201]);
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
      actorId,
    },
  });
  assertOk(res.res, 'POST /qc-events (accept)', res.payload, { receiptLineId, quantity }, [201]);
}

async function getSnapshot(token, itemId, locationId) {
  const res = await apiRequest('GET', '/inventory-snapshot', {
    token,
    params: { itemId, locationId },
  });
  assertOk(res.res, 'GET /inventory-snapshot', res.payload, { itemId, locationId }, [200]);
  const row = res.payload.data?.[0];
  return Number(row?.onHand ?? 0);
}

test('default sellable location changes take effect immediately', async () => {
  const tenantSlug = `default-drift-${randomUUID().slice(0, 8)}`;
let db;
  const session = await getSession(tenantSlug);
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const actorId = session.user?.id;
  assert.ok(token);
  assert.ok(tenantId);
  assert.ok(actorId);

  const { warehouse, qaLocation, sellableA, sellableB } = await createWarehouseGraph(token);

  await setWarehouseDefault({
    tenantId,
    warehouseId: warehouse.id,
    role: 'QA',
    locationId: qaLocation.id,
  });
  await setWarehouseDefault({
    tenantId,
    warehouseId: warehouse.id,
    role: 'SELLABLE',
    locationId: sellableA.id,
  });

  const itemId = await createItem(token, sellableA.id);
  const vendorRes = await apiRequest('POST', '/vendors', {
    token,
    body: { code: `V-${randomUUID().slice(0, 8)}`, name: 'Default Drift Vendor' },
  });
  assertOk(vendorRes.res, 'POST /vendors', vendorRes.payload, null, [201]);
  const vendorId = vendorRes.payload.id;

  const receiptLineA = await receiveIntoQa(token, vendorId, itemId, qaLocation.id, 5);
  await qcAccept(token, receiptLineA, 5, actorId);

  const onHandA1 = await getSnapshot(token, itemId, sellableA.id);
  const onHandB1 = await getSnapshot(token, itemId, sellableB.id);
  if (Math.abs(onHandA1 - 5) > 1e-6 || Math.abs(onHandB1) > 1e-6) {
    const defaults = await db.query(
      `SELECT role, location_id FROM warehouse_default_location WHERE tenant_id = $1 AND warehouse_id = $2`,
      [tenantId, warehouse.id]
    );
    const diag = {
      tenantId,
      warehouseId: warehouse.id,
      qa: formatLocation(qaLocation),
      sellableA: formatLocation(sellableA),
      sellableB: formatLocation(sellableB),
      defaults: defaults.rows,
      onHandA1,
      onHandB1,
    };
    throw new Error(`DEFAULT_DRIFT_ASSERT_1\n${safeJson(diag)}`);
  }

  await setWarehouseDefault({
    tenantId,
    warehouseId: warehouse.id,
    role: 'SELLABLE',
    locationId: sellableB.id,
  });

  const receiptLineB = await receiveIntoQa(token, vendorId, itemId, qaLocation.id, 7);
  await qcAccept(token, receiptLineB, 7, actorId);

  const onHandA2 = await getSnapshot(token, itemId, sellableA.id);
  const onHandB2 = await getSnapshot(token, itemId, sellableB.id);
  if (Math.abs(onHandA2 - 5) > 1e-6 || Math.abs(onHandB2 - 7) > 1e-6) {
    const defaults = await db.query(
      `SELECT role, location_id FROM warehouse_default_location WHERE tenant_id = $1 AND warehouse_id = $2`,
      [tenantId, warehouse.id]
    );
    const diag = {
      tenantId,
      warehouseId: warehouse.id,
      qa: formatLocation(qaLocation),
      sellableA: formatLocation(sellableA),
      sellableB: formatLocation(sellableB),
      defaults: defaults.rows,
      onHandA2,
      onHandB2,
    };
    throw new Error(`DEFAULT_DRIFT_ASSERT_2\n${safeJson(diag)}`);
  }
});
