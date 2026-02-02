import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `reservation-lifecycle-${Date.now()}`;

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
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { res, payload };
}

async function ensureSession() {
  const bootstrap = await apiRequest('POST', '/auth/bootstrap', {
    body: {
      adminEmail,
      adminPassword,
      tenantSlug,
      tenantName: 'Reservation Lifecycle Tenant',
    },
  });
  if (bootstrap.res.ok) return bootstrap.payload;
  assert.equal(bootstrap.res.status, 409);

  const login = await apiRequest('POST', '/auth/login', {
    body: { email: adminEmail, password: adminPassword, tenantSlug },
  });
  assert.equal(login.res.status, 200);
  return login.payload;
}

async function ensureWarehouse(token) {
  await apiRequest('POST', '/locations/templates/standard-warehouse', {
    token,
    body: { includeReceivingQc: true },
  });
  const locationsRes = await apiRequest('GET', '/locations', { token, params: { limit: 200 } });
  assert.equal(locationsRes.res.status, 200);
  const locations = locationsRes.payload.data || [];
  const warehouse = locations.find((loc) => loc.type === 'warehouse');
  assert.ok(warehouse);
  const sellable = locations.find((loc) => loc.role === 'SELLABLE');
  assert.ok(sellable);
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

  const { sellable } = await ensureWarehouse(token);
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
