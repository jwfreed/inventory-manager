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

const sharedPool = createPool();

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
    tenantName: 'Reservation Lifecycle Tenant',
  };
  const bootstrap = await apiRequest('POST', '/auth/bootstrap', { body: bootstrapBody });
  if (bootstrap.res.ok) return bootstrap.payload;
  assertOk(bootstrap.res, 'POST /auth/bootstrap', bootstrap.payload, bootstrapBody, [200, 201, 409]);

  const loginBody = { email: adminEmail, password: adminPassword, tenantSlug };
  const login = await apiRequest('POST', '/auth/login', { body: loginBody });
  assertOk(login.res, 'POST /auth/login', login.payload, loginBody, [200]);
  return login.payload;
}

async function ensureWarehouse(token, tenantId, pool = sharedPool) {
  if (!tenantId) {
    const meRes = await apiRequest('GET', '/auth/me', { token });
    assert.equal(meRes.res.status, 200);
    tenantId = meRes.payload?.tenantId || meRes.payload?.tenant?.id || meRes.payload?.user?.tenantId;
  }
  assert.ok(tenantId);
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
  await ensureRole('HOLD');
  await ensureRole('REJECT');
  const defaultsRes = await pool.query(
    `SELECT location_id
       FROM warehouse_default_location
      WHERE tenant_id = $1 AND warehouse_id = $2 AND role = 'SELLABLE'`,
    [tenantId, warehouse.id]
  );
  const defaultSellableId = defaultsRes.rows[0]?.location_id;
  const sellable =
    locations.find((loc) => loc.id === defaultSellableId) ||
    locations.find((loc) => loc.role === 'SELLABLE' && loc.parentLocationId === warehouse.id) ||
    locations.find((loc) => loc.role === 'SELLABLE');
  assert.ok(sellable);
  const byId = new Map(locations.map((loc) => [loc.id, loc]));
  const diagnostics = {
    warehouseId: warehouse.id,
    warehouse: formatLocation(warehouse),
    sellable: formatLocation(sellable),
    locations: locations.map(formatLocation),
    defaults: defaultsRes.rows
  };
  if (warehouse.parentLocationId !== null || warehouse.type !== 'warehouse') {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID root\n${safeJson(diagnostics)}`);
  }
  if (!sellable.parentLocationId || !isDescendant(sellable, warehouse.id, byId)) {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID sellable\n${safeJson(diagnostics)}`);
  }
  return { warehouse, sellable };
}

async function seedItemAndStock(token, sellableLocationId, quantity = 10) {
  const sku = `RES-${randomUUID()}`;
  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: sellableLocationId,
    },
  });
  assert.equal(itemRes.res.status, 201);
  const itemId = itemRes.payload.id;

  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      reasonCode: 'seed',
      lines: [
        {
          lineNumber: 1,
          itemId,
          locationId: sellableLocationId,
          uom: 'each',
          quantityDelta: quantity,
          reasonCode: 'seed',
        },
      ],
    },
  });
  assert.equal(adjustmentRes.res.status, 201);
  const postRes = await apiRequest('POST', `/inventory-adjustments/${adjustmentRes.payload.id}/post`, { token });
  assert.equal(postRes.res.status, 200);
  return itemId;
}

test('Reserve → Cancel → ATP returns', async (t) => {
  const pool = createPool();
  t.after(async () => {
    await pool.end();
  });

  const session = await ensureSession();
  const token = session.accessToken;
  assert.ok(token);

  const { sellable } = await ensureWarehouse(token, session.tenant.id, pool);
  const itemId = await seedItemAndStock(token, sellable.id, 10);

  const reserveRes = await apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `reserve-${randomUUID()}` },
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId,
          locationId: sellable.id,
          uom: 'each',
          quantityReserved: 5,
          allowBackorder: false,
        },
      ],
    },
  });
  assert.equal(reserveRes.res.status, 201);
  const reservationId = reserveRes.payload.data[0].id;

  const atpRes = await apiRequest('GET', '/atp', { token, params: { itemId } });
  assert.equal(atpRes.res.status, 200);
  const row = (atpRes.payload.data || []).find((r) => r.locationId === sellable.id);
  assert.ok(row);
  assert.ok(Math.abs(Number(row.availableToPromise) - 5) < 1e-6);

  const cancelRes = await apiRequest('POST', `/reservations/${reservationId}/cancel`, {
    token,
    headers: { 'Idempotency-Key': `cancel-${randomUUID()}` },
    body: { reason: 'test' },
  });
  assert.equal(cancelRes.res.status, 200);

  const atpRes2 = await apiRequest('GET', '/atp', { token, params: { itemId } });
  assert.equal(atpRes2.res.status, 200);
  const row2 = (atpRes2.payload.data || []).find((r) => r.locationId === sellable.id);
  assert.ok(row2);
  assert.ok(Math.abs(Number(row2.availableToPromise) - 10) < 1e-6);
});

test('Reserve → Allocate → Fulfill keeps ATP reduced until fulfilled', async (t) => {
  const pool = createPool();
  t.after(async () => {
    await pool.end();
  });

  const session = await ensureSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { sellable } = await ensureWarehouse(token);
  const itemId = await seedItemAndStock(token, sellable.id, 8);

  const reserveRes = await apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `reserve-${randomUUID()}` },
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId,
          locationId: sellable.id,
          uom: 'each',
          quantityReserved: 4,
          allowBackorder: false,
        },
      ],
    },
  });
  assert.equal(reserveRes.res.status, 201);
  const reservationId = reserveRes.payload.data[0].id;

  const allocateRes = await apiRequest('POST', `/reservations/${reservationId}/allocate`, {
    token,
    headers: { 'Idempotency-Key': `alloc-${randomUUID()}` },
  });
  assert.equal(allocateRes.res.status, 200);
  assert.equal(allocateRes.payload.status, 'ALLOCATED');

  const fulfillRes = await apiRequest('POST', `/reservations/${reservationId}/fulfill`, {
    token,
    headers: { 'Idempotency-Key': `fulfill-${randomUUID()}` },
    body: { quantity: 4 },
  });
  assert.equal(fulfillRes.res.status, 200);
  assert.equal(fulfillRes.payload.status, 'FULFILLED');

  const balanceRes = await pool.query(
    `SELECT reserved, allocated
       FROM inventory_balance
      WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4`,
    [tenantId, itemId, sellable.id, 'each']
  );
  assert.equal(balanceRes.rowCount, 1);
  assert.ok(Math.abs(Number(balanceRes.rows[0].reserved)) < 1e-6);
  assert.ok(Math.abs(Number(balanceRes.rows[0].allocated)) < 1e-6);
});

test('Retry reserve with same idempotency key does not duplicate', async (t) => {
  const pool = createPool();
  t.after(async () => {
    await pool.end();
  });

  const session = await ensureSession();
  const token = session.accessToken;
  assert.ok(token);

  const { sellable } = await ensureWarehouse(token);
  const itemId = await seedItemAndStock(token, sellable.id, 5);

  const idemKey = `reserve-${randomUUID()}`;
  const body = {
    reservations: [
      {
        demandType: 'sales_order_line',
        demandId: randomUUID(),
        itemId,
        locationId: sellable.id,
        uom: 'each',
        quantityReserved: 3,
        allowBackorder: false,
      },
    ],
  };
  const res1 = await apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': idemKey },
    body,
  });
  assert.equal(res1.res.status, 201);
  const res2 = await apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': idemKey },
    body,
  });
  assert.equal(res2.res.status, 201);
  assert.equal(res2.payload.data[0].id, res1.payload.data[0].id);
});

test('Concurrent reserve with same idempotency key returns same reservation', async (t) => {
  const pool = createPool();
  t.after(async () => {
    await pool.end();
  });

  const session = await ensureSession();
  const token = session.accessToken;
  assert.ok(token);

  const { sellable } = await ensureWarehouse(token);
  const itemId = await seedItemAndStock(token, sellable.id, 5);

  const idemKey = `reserve-${randomUUID()}`;
  const body = {
    reservations: [
      {
        demandType: 'sales_order_line',
        demandId: randomUUID(),
        itemId,
        locationId: sellable.id,
        uom: 'each',
        quantityReserved: 2,
        allowBackorder: false,
      },
    ],
  };

  const [r1, r2] = await Promise.all([
    apiRequest('POST', '/reservations', { token, headers: { 'Idempotency-Key': idemKey }, body }),
    apiRequest('POST', '/reservations', { token, headers: { 'Idempotency-Key': idemKey }, body }),
  ]);

  assert.ok([200, 201].includes(r1.res.status));
  assert.ok([200, 201].includes(r2.res.status));
  assert.equal(r1.payload.data[0].id, r2.payload.data[0].id);
});

test('Concurrent reservations against limited stock: one succeeds, one fails', async (t) => {
  const pool = createPool();
  t.after(async () => {
    await pool.end();
  });

  const session = await ensureSession();
  const token = session.accessToken;
  assert.ok(token);

  const { sellable } = await ensureWarehouse(token);
  const itemId = await seedItemAndStock(token, sellable.id, 5);

  const makeReservation = (key) =>
    apiRequest('POST', '/reservations', {
      token,
      headers: { 'Idempotency-Key': key },
      body: {
        reservations: [
          {
            demandType: 'sales_order_line',
            demandId: randomUUID(),
            itemId,
            locationId: sellable.id,
            uom: 'each',
            quantityReserved: 5,
            allowBackorder: false,
          },
        ],
      },
    });

  const [r1, r2] = await Promise.all([
    makeReservation(`reserve-${randomUUID()}`),
    makeReservation(`reserve-${randomUUID()}`),
  ]);

  const statuses = [r1.res.status, r2.res.status].sort();
  assert.deepEqual(statuses, [201, 409]);
});

test('Guardrails reject illegal transitions', async (t) => {
  const pool = createPool();
  t.after(async () => {
    await pool.end();
  });

  const session = await ensureSession();
  const token = session.accessToken;
  assert.ok(token);

  const { sellable } = await ensureWarehouse(token);
  const itemId = await seedItemAndStock(token, sellable.id, 5);

  const reserveRes = await apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `reserve-${randomUUID()}` },
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId,
          locationId: sellable.id,
          uom: 'each',
          quantityReserved: 2,
          allowBackorder: false,
        },
      ],
    },
  });
  assert.equal(reserveRes.res.status, 201);
  const reservationId = reserveRes.payload.data[0].id;

  const fulfillRes = await apiRequest('POST', `/reservations/${reservationId}/fulfill`, {
    token,
    headers: { 'Idempotency-Key': `fulfill-${randomUUID()}` },
    body: { quantity: 1 },
  });
  assert.equal(fulfillRes.res.status, 409);

  const allocRes = await apiRequest('POST', `/reservations/${reservationId}/allocate`, {
    token,
    headers: { 'Idempotency-Key': `alloc-${randomUUID()}` },
  });
  assert.equal(allocRes.res.status, 200);

  const cancelRes = await apiRequest('POST', `/reservations/${reservationId}/cancel`, {
    token,
    headers: { 'Idempotency-Key': `cancel-${randomUUID()}` },
    body: { reason: 'test' },
  });
  assert.equal(cancelRes.res.status, 409);
});
