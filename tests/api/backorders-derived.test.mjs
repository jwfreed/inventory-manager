import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = process.env.SEED_TENANT_SLUG || 'default';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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

async function ensureSession() {
  const bootstrapBody = {
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Backorder Derived Tenant'
  };
  const bootstrap = await apiRequest('POST', '/auth/bootstrap', { body: bootstrapBody });
  if (bootstrap.res.ok) return bootstrap.payload;
  assertOk(bootstrap.res, 'POST /auth/bootstrap', bootstrap.payload, bootstrapBody, [200, 201, 409]);

  const loginBody = { email: adminEmail, password: adminPassword, tenantSlug };
  const login = await apiRequest('POST', '/auth/login', { body: loginBody });
  assertOk(login.res, 'POST /auth/login', login.payload, loginBody, [200]);
  return login.payload;
}

async function ensureWarehouse(token, tenantId) {
  const locationsRes = await apiRequest('GET', '/locations', { token, params: { limit: 200 } });
  assert.equal(locationsRes.res.status, 200);
  let locations = locationsRes.payload.data || [];
  let warehouse = locations.find((loc) => loc.type === 'warehouse');
  if (!warehouse) {
    const code = `WH-${randomUUID()}`;
    const body = {
      code,
      name: `Warehouse ${code}`,
      type: 'warehouse',
      role: 'SELLABLE',
      isSellable: true,
      active: true
    };
    const createRes = await apiRequest('POST', '/locations', { token, body });
    assertOk(createRes.res, 'POST /locations (warehouse)', createRes.payload, body, [201]);
    warehouse = createRes.payload;
    locations = [...locations, warehouse];
  }
  const ensureRole = async (role) => {
    let loc = locations.find(
      (entry) => entry.role === role && entry.parentLocationId === warehouse.id
    );
    if (!loc) {
      const code = `${role}-${randomUUID().slice(0, 8)}`;
      const body = {
        code,
        name: `${role} Location`,
        type: role === 'SCRAP' ? 'scrap' : 'bin',
        role,
        isSellable: role === 'SELLABLE',
        parentLocationId: warehouse.id
      };
      const createRes = await apiRequest('POST', '/locations', { token, body });
      assertOk(createRes.res, `POST /locations (${role})`, createRes.payload, body, [201]);
      loc = createRes.payload;
      locations = [...locations, loc];
    }
    await pool.query(
      `INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [tenantId, warehouse.id, role, loc.id]
    );
    return loc;
  };
  await ensureRole('SELLABLE');
  await ensureRole('QA');

  const defaultsRes = await pool.query(
    `SELECT role, location_id
       FROM warehouse_default_location
      WHERE tenant_id = $1 AND warehouse_id = $2`,
    [tenantId, warehouse.id]
  );
  const defaults = new Map(defaultsRes.rows.map((row) => [row.role, row.location_id]));
  const qaId = defaults.get('QA');
  const sellableId = defaults.get('SELLABLE');
  assert.ok(qaId);
  assert.ok(sellableId);
  const qa = locations.find((loc) => loc.id === qaId);
  const sellable = locations.find((loc) => loc.id === sellableId);
  assert.ok(qa);
  assert.ok(sellable);
  const byId = new Map(locations.map((loc) => [loc.id, loc]));
  const diagnostics = {
    warehouseId: warehouse.id,
    warehouse: formatLocation(warehouse),
    qaLocation: formatLocation(qa),
    sellableLocation: formatLocation(sellable),
    locations: locations.map(formatLocation),
    defaults: defaultsRes.rows
  };
  if (warehouse.parentLocationId !== null || warehouse.type !== 'warehouse') {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID root\n${safeJson(diagnostics)}`);
  }
  if (!qa.parentLocationId || !isDescendant(qa, warehouse.id, byId)) {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID qa\n${safeJson(diagnostics)}`);
  }
  if (!sellable.parentLocationId || !isDescendant(sellable, warehouse.id, byId)) {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID sellable\n${safeJson(diagnostics)}`);
  }
  return { qa, sellable };
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
  await pool.query(
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

test('Derived backorder tracks sellable supply and commitments', async (t) => {
  t.after(async () => {
    await pool.end();
  });

  const session = await ensureSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const userId = session.user?.id;
  assert.ok(token);
  assert.ok(tenantId);
  assert.ok(userId);

  const { qa, sellable } = await ensureWarehouse(token, tenantId);
  const vendorId = await createVendor(token);
  const customerId = await createCustomer(tenantId);
  const itemId = await createItem(token, sellable.id);
  const { orderId, lineId } = await createSalesOrder(token, customerId, itemId, 10, sellable.id);

  const initialBackorder = await getLineBackorder(token, orderId);
  assert.ok(Math.abs(initialBackorder - 10) < 1e-6);

  const receiptLineId = await receiveIntoQa(token, vendorId, itemId, sellable.id, 10);
  const afterQaReceipt = await getLineBackorder(token, orderId);
  assert.ok(Math.abs(afterQaReceipt - 10) < 1e-6, `Expected backorder unchanged after QA receipt`);

  await qcAccept(token, receiptLineId, 10, userId);
  const afterQcAccept = await getLineBackorder(token, orderId);
  assert.ok(Math.abs(afterQcAccept) < 1e-6, `Expected backorder to clear after QC accept`);

  const reservationId = await createReservation(token, lineId, itemId, sellable.id, 2);
  const afterReserve = await getLineBackorder(token, orderId);
  assert.ok(Math.abs(afterReserve - 2) < 1e-6, `Expected backorder to increase after reservation`);

  await cancelReservation(token, reservationId);
  const afterCancel = await getLineBackorder(token, orderId);
  assert.ok(Math.abs(afterCancel) < 1e-6, `Expected backorder to return to 0 after cancel`);
});
