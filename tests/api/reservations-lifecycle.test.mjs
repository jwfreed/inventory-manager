import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSession } from './helpers/ensureSession.mjs';
import { ensureStandardWarehouse } from './helpers/warehouse-bootstrap.mjs';
import { waitForCondition } from './helpers/waitFor.mjs';

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

async function getSession() {
  const session = await ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: 'Reservation Lifecycle Tenant'
  });
  db = session.pool;
  return session;
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

test('Reserve → Cancel → ATP returns', async () => {
  const session = await getSession();
  const token = session.accessToken;
  assert.ok(token);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});
  const sellable = defaults.SELLABLE;
  const itemId = await seedItemAndStock(token, sellable.id, 10);

  const atpInitialRes = await apiRequest('GET', '/atp', { token, params: { itemId } });
  assert.equal(atpInitialRes.res.status, 200);
  const initialRow = (atpInitialRes.payload.data || []).find((r) => r.locationId === sellable.id);
  assert.ok(initialRow);
  const initialATP = Number(initialRow.availableToPromise);

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

  await waitForCondition(
    async () => {
      const atpRes = await apiRequest('GET', '/atp', { token, params: { itemId } });
      assert.equal(atpRes.res.status, 200);
      const row = (atpRes.payload.data || []).find((r) => r.locationId === sellable.id);
      return row ? Number(row.availableToPromise) : null;
    },
    (available) => typeof available === 'number' && available < initialATP,
    { label: 'ATP reduced after reservation' }
  );

  const cancelRes = await apiRequest('POST', `/reservations/${reservationId}/cancel`, {
    token,
    headers: { 'Idempotency-Key': `cancel-${randomUUID()}` },
    body: { reason: 'test' },
  });
  assert.equal(cancelRes.res.status, 200);

  await waitForCondition(
    async () => {
      const atpRes2 = await apiRequest('GET', '/atp', { token, params: { itemId } });
      assert.equal(atpRes2.res.status, 200);
      const row2 = (atpRes2.payload.data || []).find((r) => r.locationId === sellable.id);
      return row2 ? Number(row2.availableToPromise) : null;
    },
    (available) => typeof available === 'number' && Math.abs(available - initialATP) < 1e-6,
    { label: 'ATP restored after cancel' }
  );
});

test('Reserve → Allocate → Fulfill keeps ATP reduced until fulfilled', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});
  const sellable = defaults.SELLABLE;
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

  const balanceRes = await db.query(
    `SELECT reserved, allocated
       FROM inventory_balance
      WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4`,
    [tenantId, itemId, sellable.id, 'each']
  );
  assert.equal(balanceRes.rowCount, 1);
  assert.ok(Math.abs(Number(balanceRes.rows[0].reserved)) < 1e-6);
  assert.ok(Math.abs(Number(balanceRes.rows[0].allocated)) < 1e-6);
});

test('Retry reserve with same idempotency key does not duplicate', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});
  const sellable = defaults.SELLABLE;
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

test('Concurrent reserve with same idempotency key returns same reservation', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});
  const sellable = defaults.SELLABLE;
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

test('Concurrent reservations against limited stock: one succeeds, one fails', async () => {
  const session = await getSession();
  const token = session.accessToken;
  assert.ok(token);

  const tenantId = session.tenant?.id;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});
  const sellable = defaults.SELLABLE;
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

test('Guardrails reject illegal transitions', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});
  const sellable = defaults.SELLABLE;
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
