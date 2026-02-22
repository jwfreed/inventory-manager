import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `res-concurrency-${randomUUID().slice(0, 8)}`;
const openPools = new Set();

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
    tenantName: 'Reservation Concurrency Tenant'
  });
  if (session.pool) openPools.add(session.pool);
  return session;
}

test.after(async () => {
  await Promise.all(
    Array.from(openPools).map(async (pool) => {
      try {
        await pool.end();
      } catch {
        // Ignore shutdown issues in teardown.
      }
    })
  );
  openPools.clear();
});

async function createItem(token, defaultLocationId, suffix = 'ITEM') {
  const sku = `${suffix}-${randomUUID().slice(0, 8)}`;
  const itemRes = await apiRequest('POST', '/items', {
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
  assert.equal(itemRes.res.status, 201);
  return itemRes.payload.id;
}

async function seedStock(token, itemId, locationId, quantity) {
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
}

async function createReservationRequest(token, reservation, idempotencyKey) {
  assert.ok(reservation?.warehouseId, 'warehouseId is required for reservation requests');
  return apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: { reservations: [reservation] }
  });
}

async function deleteBalanceRow(db, tenantId, itemId, locationId, uom = 'each') {
  await db.query(
    `DELETE FROM inventory_balance
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = $4`,
    [tenantId, itemId, locationId, uom]
  );
}

async function sumReserved(db, tenantId, itemId, locationId, uom = 'each') {
  const res = await db.query(
    `SELECT COALESCE(
        SUM(GREATEST(0, quantity_reserved - COALESCE(quantity_fulfilled, 0))),
        0
      ) AS reserved_total
       FROM inventory_reservations
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = $4
        AND status IN ('RESERVED', 'ALLOCATED')`,
    [tenantId, itemId, locationId, uom]
  );
  return Number(res.rows[0]?.reserved_total ?? 0);
}

async function sumBackordered(db, tenantId, itemId, locationId, uom = 'each') {
  const res = await db.query(
    `SELECT COALESCE(SUM(quantity_backordered), 0) AS backordered_total
       FROM inventory_backorders
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = $4
        AND status = 'open'`,
    [tenantId, itemId, locationId, uom]
  );
  return Number(res.rows[0]?.backordered_total ?? 0);
}

async function fetchBalance(db, tenantId, itemId, locationId, uom = 'each') {
  const res = await db.query(
    `SELECT on_hand, reserved, allocated
       FROM inventory_balance
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = $4`,
    [tenantId, itemId, locationId, uom]
  );
  return {
    onHand: Number(res.rows[0]?.on_hand ?? 0),
    reserved: Number(res.rows[0]?.reserved ?? 0),
    allocated: Number(res.rows[0]?.allocated ?? 0)
  };
}

test('No oversell under concurrency when balance row is initially missing (no backorder)', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:no-oversell` });
  const sellable = defaults.SELLABLE;
  const itemId = await createItem(token, sellable.id, 'OVRSELL');
  await seedStock(token, itemId, sellable.id, 5);

  await deleteBalanceRow(db, tenantId, itemId, sellable.id, 'each');

  const attempts = 30;
  const requests = Array.from({ length: attempts }, () =>
    createReservationRequest(
      token,
      {
        demandType: 'sales_order_line',
        demandId: randomUUID(),
        itemId,
        warehouseId: warehouse.id,
        locationId: sellable.id,
        uom: 'each',
        quantityReserved: 1,
        allowBackorder: false
      },
      `reserve-${randomUUID()}`
    )
  );

  const responses = await Promise.all(requests);
  const statuses = responses.map((resp) => resp.res.status);
  const successCount = statuses.filter((status) => status === 201).length;
  const conflictCount = statuses.filter((status) => status === 409).length;
  const unexpectedStatuses = statuses.filter((status) => status !== 201 && status !== 409);
  assert.equal(unexpectedStatuses.length, 0, `Unexpected statuses: ${statuses.join(',')}`);
  const conflictCodes = new Set(
    responses
      .filter((resp) => resp.res.status === 409)
      .map((resp) => resp.payload?.error?.code)
      .filter(Boolean)
  );
  const allowedConflictCodes = new Set(['ATP_INSUFFICIENT_AVAILABLE', 'ATP_CONCURRENCY_EXHAUSTED']);
  for (const code of conflictCodes) {
    assert.ok(allowedConflictCodes.has(code), `unexpected conflict code ${code}`);
  }
  assert.ok(successCount <= 5, `Successful reservations exceeded stock: success=${successCount}`);
  assert.ok(conflictCount >= 1, 'Expected at least one insufficient-availability conflict');

  const reservedTotal = await sumReserved(db, tenantId, itemId, sellable.id, 'each');
  assert.ok(reservedTotal <= 5 + 1e-6, `Reserved total oversold: ${reservedTotal}`);
  assert.ok(Math.abs(reservedTotal - successCount) < 1e-6, `Reserved total ${reservedTotal} != success count ${successCount}`);
});

test('Backorder mode reserves up to available under concurrency when balance row is initially missing', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:backorder` });
  const sellable = defaults.SELLABLE;
  const itemId = await createItem(token, sellable.id, 'BKO');
  await seedStock(token, itemId, sellable.id, 5);

  await deleteBalanceRow(db, tenantId, itemId, sellable.id, 'each');

  const attempts = 10;
  const requests = Array.from({ length: attempts }, () =>
    createReservationRequest(
      token,
      {
        demandType: 'sales_order_line',
        demandId: randomUUID(),
        itemId,
        warehouseId: warehouse.id,
        locationId: sellable.id,
        uom: 'each',
        quantityReserved: 1,
        allowBackorder: true
      },
      `reserve-${randomUUID()}`
    )
  );

  const responses = await Promise.all(requests);
  const statuses = responses.map((resp) => resp.res.status);
  const unexpectedStatuses = statuses.filter((status) => status !== 201);
  assert.equal(unexpectedStatuses.length, 0, `Unexpected statuses: ${statuses.join(',')}`);

  const reservedTotal = await sumReserved(db, tenantId, itemId, sellable.id, 'each');
  const backorderedTotal = await sumBackordered(db, tenantId, itemId, sellable.id, 'each');
  assert.ok(Math.abs(reservedTotal - 5) < 1e-6, `Expected reserved=5, got ${reservedTotal}`);
  assert.ok(Math.abs(backorderedTotal - 5) < 1e-6, `Expected backordered=5, got ${backorderedTotal}`);
});

test('Opposite-order multi-line reservation requests complete without deadlocks', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:deadlock-order` });
  const sellable = defaults.SELLABLE;

  const itemA = await createItem(token, sellable.id, 'LOCKA');
  const itemB = await createItem(token, sellable.id, 'LOCKB');
  await seedStock(token, itemA, sellable.id, 6);
  await seedStock(token, itemB, sellable.id, 6);

  await deleteBalanceRow(db, tenantId, itemA, sellable.id, 'each');
  await deleteBalanceRow(db, tenantId, itemB, sellable.id, 'each');

  const forwardLineA = {
    demandType: 'sales_order_line',
    demandId: randomUUID(),
    itemId: itemA,
    warehouseId: warehouse.id,
    locationId: sellable.id,
    uom: 'each',
    quantityReserved: 2,
    allowBackorder: false
  };
  const forwardLineB = {
    demandType: 'sales_order_line',
    demandId: randomUUID(),
    itemId: itemB,
    warehouseId: warehouse.id,
    locationId: sellable.id,
    uom: 'each',
    quantityReserved: 2,
    allowBackorder: false
  };
  const reverseLineA = {
    demandType: 'sales_order_line',
    demandId: randomUUID(),
    itemId: itemA,
    warehouseId: warehouse.id,
    locationId: sellable.id,
    uom: 'each',
    quantityReserved: 2,
    allowBackorder: false
  };
  const reverseLineB = {
    demandType: 'sales_order_line',
    demandId: randomUUID(),
    itemId: itemB,
    warehouseId: warehouse.id,
    locationId: sellable.id,
    uom: 'each',
    quantityReserved: 2,
    allowBackorder: false
  };

  const reqForward = apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `reserve-${randomUUID()}` },
    body: { reservations: [forwardLineA, forwardLineB] }
  });
  const reqReverse = apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `reserve-${randomUUID()}` },
    body: { reservations: [reverseLineB, reverseLineA] }
  });

  const [forward, reverse] = await Promise.all([reqForward, reqReverse]);
  assert.equal(forward.res.status, 201, `forward status=${forward.res.status} body=${JSON.stringify(forward.payload)}`);
  assert.equal(reverse.res.status, 201, `reverse status=${reverse.res.status} body=${JSON.stringify(reverse.payload)}`);

  const reservedA = await sumReserved(db, tenantId, itemA, sellable.id, 'each');
  const reservedB = await sumReserved(db, tenantId, itemB, sellable.id, 'each');
  assert.ok(Math.abs(reservedA - 4) < 1e-6, `Expected itemA reserved=4, got ${reservedA}`);
  assert.ok(Math.abs(reservedB - 4) < 1e-6, `Expected itemB reserved=4, got ${reservedB}`);
});

test('concurrent reserve/allocate/fulfill is bounded and deterministic for one SKU+warehouse', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({
    token,
    apiRequest,
    scope: `${import.meta.url}:reserve-allocate-fulfill`
  });
  const sellable = defaults.SELLABLE;
  const itemId = await createItem(token, sellable.id, 'RACE');
  await seedStock(token, itemId, sellable.id, 12);
  await deleteBalanceRow(db, tenantId, itemId, sellable.id, 'each');

  const attempts = 20;
  const workflows = Array.from({ length: attempts }, async () => {
    const reserve = await createReservationRequest(
      token,
      {
        demandType: 'sales_order_line',
        demandId: randomUUID(),
        itemId,
        warehouseId: warehouse.id,
        locationId: sellable.id,
        uom: 'each',
        quantityReserved: 1,
        allowBackorder: false
      },
      `reserve-${randomUUID()}`
    );
    if (reserve.res.status !== 201) {
      return { reserveStatus: reserve.res.status, reservePayload: reserve.payload };
    }

    const reservationId = reserve.payload?.data?.[0]?.id;
    const allocate = await apiRequest('POST', `/reservations/${reservationId}/allocate`, {
      token,
      headers: { 'Idempotency-Key': `allocate-${randomUUID()}` },
      body: { warehouseId: warehouse.id }
    });
    if (allocate.res.status !== 200) {
      return {
        reserveStatus: reserve.res.status,
        allocateStatus: allocate.res.status,
        allocatePayload: allocate.payload
      };
    }

    const fulfill = await apiRequest('POST', `/reservations/${reservationId}/fulfill`, {
      token,
      headers: { 'Idempotency-Key': `fulfill-${randomUUID()}` },
      body: { warehouseId: warehouse.id, quantity: 1 }
    });
    return {
      reserveStatus: reserve.res.status,
      allocateStatus: allocate.res.status,
      fulfillStatus: fulfill.res.status,
      fulfillPayload: fulfill.payload
    };
  });

  const outcomes = await Promise.all(workflows);
  const allowedConflictCodes = new Set(['ATP_INSUFFICIENT_AVAILABLE', 'ATP_CONCURRENCY_EXHAUSTED', 'RESERVATION_INVALID_STATE']);
  for (const outcome of outcomes) {
    if (outcome.reserveStatus === 409) {
      const code = outcome.reservePayload?.error?.code ?? null;
      if (code) {
        assert.ok(allowedConflictCodes.has(code), `unexpected reserve code=${code}`);
      }
    }
    if (outcome.allocateStatus === 409) {
      const code = outcome.allocatePayload?.error?.code ?? null;
      if (code) {
        assert.ok(allowedConflictCodes.has(code), `unexpected allocate code=${code}`);
      }
    }
    if (outcome.fulfillStatus === 409) {
      const code = outcome.fulfillPayload?.error?.code ?? null;
      if (code) {
        assert.ok(allowedConflictCodes.has(code), `unexpected fulfill code=${code}`);
      }
    }
    const statuses = [outcome.reserveStatus, outcome.allocateStatus, outcome.fulfillStatus].filter(Boolean);
    for (const status of statuses) {
      assert.ok([200, 201, 409].includes(status), `unexpected status ${status}`);
    }
  }

  const balance = await fetchBalance(db, tenantId, itemId, sellable.id, 'each');
  assert.ok(balance.onHand >= -1e-6, `on_hand must be non-negative, got ${balance.onHand}`);
  assert.ok(balance.reserved >= -1e-6, `reserved must be non-negative, got ${balance.reserved}`);
  assert.ok(balance.allocated >= -1e-6, `allocated must be non-negative, got ${balance.allocated}`);
  assert.ok(
    balance.reserved + balance.allocated <= balance.onHand + 1e-6,
    `committed exceeded on_hand: committed=${balance.reserved + balance.allocated}, on_hand=${balance.onHand}`
  );
});
