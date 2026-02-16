import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `balance-inv-${randomUUID().slice(0, 8)}`;
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
    tenantName: 'Inventory Balance Invariants Tenant'
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
        // Ignore teardown close issues.
      }
    })
  );
  openPools.clear();
});

function nearlyEqual(left, right, epsilon = 1e-6) {
  return Math.abs(left - right) <= epsilon;
}

async function createItem(token, defaultLocationId, prefix = 'ITEM') {
  const sku = `${prefix}-${randomUUID().slice(0, 8)}`;
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

async function readBalance(db, tenantId, itemId, locationId, uom = 'each') {
  const res = await db.query(
    `SELECT on_hand, reserved, allocated
       FROM inventory_balance
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = $4`,
    [tenantId, itemId, locationId, uom]
  );
  assert.equal(res.rowCount, 1, 'expected inventory_balance row to exist');
  return {
    onHand: Number(res.rows[0].on_hand),
    reserved: Number(res.rows[0].reserved),
    allocated: Number(res.rows[0].allocated)
  };
}

async function readOpenCommitments(db, tenantId, itemId, locationId, uom = 'each') {
  const res = await db.query(
    `SELECT
       COALESCE(
         SUM(
           CASE
             WHEN status = 'RESERVED'
             THEN GREATEST(0, quantity_reserved - COALESCE(quantity_fulfilled, 0))
             ELSE 0
           END
         ),
         0
       ) AS reserved_open,
       COALESCE(
         SUM(
           CASE
             WHEN status = 'ALLOCATED'
             THEN GREATEST(0, quantity_reserved - COALESCE(quantity_fulfilled, 0))
             ELSE 0
           END
         ),
         0
       ) AS allocated_open
      FROM inventory_reservations
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = $4
        AND status IN ('RESERVED', 'ALLOCATED')`,
    [tenantId, itemId, locationId, uom]
  );
  return {
    reservedOpen: Number(res.rows[0].reserved_open),
    allocatedOpen: Number(res.rows[0].allocated_open)
  };
}

async function assertBalanceMatchesOpenCommitments(db, tenantId, itemId, locationId, uom = 'each') {
  const balance = await readBalance(db, tenantId, itemId, locationId, uom);
  const open = await readOpenCommitments(db, tenantId, itemId, locationId, uom);
  assert.ok(
    nearlyEqual(balance.reserved, open.reservedOpen),
    `reserved mismatch: balance=${balance.reserved} commitments=${open.reservedOpen}`
  );
  assert.ok(
    nearlyEqual(balance.allocated, open.allocatedOpen),
    `allocated mismatch: balance=${balance.allocated} commitments=${open.allocatedOpen}`
  );
  return { balance, open };
}

test('inventory_balance reserved/allocated equals open reservation commitments across lifecycle', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const sellable = defaults.SELLABLE;

  const itemId = await createItem(token, sellable.id, 'INVAR');
  await seedStock(token, itemId, sellable.id, 10);

  const reserveRes = await apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `reserve-${randomUUID()}` },
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId,
          warehouseId: warehouse.id,
          locationId: sellable.id,
          uom: 'each',
          quantityReserved: 5,
          allowBackorder: false
        }
      ]
    }
  });
  assert.equal(reserveRes.res.status, 201, JSON.stringify(reserveRes.payload));
  const reservationId = reserveRes.payload.data[0].id;

  let snapshot = await assertBalanceMatchesOpenCommitments(db, tenantId, itemId, sellable.id, 'each');
  assert.ok(nearlyEqual(snapshot.balance.reserved, 5));
  assert.ok(nearlyEqual(snapshot.balance.allocated, 0));

  const allocateRes = await apiRequest('POST', `/reservations/${reservationId}/allocate`, {
    token,
    headers: { 'Idempotency-Key': `alloc-${randomUUID()}` },
    body: { warehouseId: warehouse.id }
  });
  assert.equal(allocateRes.res.status, 200, JSON.stringify(allocateRes.payload));
  assert.equal(allocateRes.payload.status, 'ALLOCATED');

  snapshot = await assertBalanceMatchesOpenCommitments(db, tenantId, itemId, sellable.id, 'each');
  assert.ok(nearlyEqual(snapshot.balance.reserved, 0));
  assert.ok(nearlyEqual(snapshot.balance.allocated, 5));

  const fulfillTwo = await apiRequest('POST', `/reservations/${reservationId}/fulfill`, {
    token,
    headers: { 'Idempotency-Key': `fulfill-${randomUUID()}` },
    body: { warehouseId: warehouse.id, quantity: 2 }
  });
  assert.equal(fulfillTwo.res.status, 200, JSON.stringify(fulfillTwo.payload));
  assert.equal(fulfillTwo.payload.status, 'ALLOCATED');
  assert.ok(nearlyEqual(Number(fulfillTwo.payload.quantityFulfilled ?? 0), 2));

  snapshot = await assertBalanceMatchesOpenCommitments(db, tenantId, itemId, sellable.id, 'each');
  assert.ok(nearlyEqual(snapshot.balance.allocated, 3));

  const fulfillOne = await apiRequest('POST', `/reservations/${reservationId}/fulfill`, {
    token,
    headers: { 'Idempotency-Key': `fulfill-${randomUUID()}` },
    body: { warehouseId: warehouse.id, quantity: 1 }
  });
  assert.equal(fulfillOne.res.status, 200, JSON.stringify(fulfillOne.payload));
  assert.equal(fulfillOne.payload.status, 'ALLOCATED');
  assert.ok(nearlyEqual(Number(fulfillOne.payload.quantityFulfilled ?? 0), 3));

  snapshot = await assertBalanceMatchesOpenCommitments(db, tenantId, itemId, sellable.id, 'each');
  assert.ok(nearlyEqual(snapshot.balance.allocated, 2));

  const cancelRes = await apiRequest('POST', `/reservations/${reservationId}/cancel`, {
    token,
    headers: { 'Idempotency-Key': `cancel-${randomUUID()}` },
    body: { warehouseId: warehouse.id, reason: 'remaining no longer needed' }
  });
  assert.equal(cancelRes.res.status, 200, JSON.stringify(cancelRes.payload));
  assert.equal(cancelRes.payload.status, 'CANCELLED');
  assert.ok(nearlyEqual(Number(cancelRes.payload.quantityFulfilled ?? 0), 3));

  snapshot = await assertBalanceMatchesOpenCommitments(db, tenantId, itemId, sellable.id, 'each');
  assert.ok(nearlyEqual(snapshot.balance.reserved, 0));
  assert.ok(nearlyEqual(snapshot.balance.allocated, 0));
});
