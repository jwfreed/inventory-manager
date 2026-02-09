import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSession } from './helpers/ensureSession.mjs';
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

async function getSession() {
  const session = await ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: tenantSlug
  });
  db = session.pool;
  return session;
}

async function seedItemAndStock(token, sellableLocationId, quantity = 10) {
  const sku = `LEDGER-${randomUUID()}`;
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
          reasonCode: 'seed'
        }
      ]
    }
  });
  assert.equal(adjustmentRes.res.status, 201);
  const postRes = await apiRequest('POST', `/inventory-adjustments/${adjustmentRes.payload.id}/post`, { token });
  assert.equal(postRes.res.status, 200);
  return itemId;
}

test('Ledger reconcile strict mode fails on drift when repair disabled', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});
  const sellable = defaults.SELLABLE;
  const itemId = await seedItemAndStock(token, sellable.id, 10);

  await db.query(
    `UPDATE inventory_balance
        SET on_hand = on_hand + 5
      WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4`,
    [tenantId, itemId, sellable.id, 'each']
  );

  const res = await apiRequest('POST', '/admin/inventory-ledger/reconcile', {
    token,
    body: { mode: 'strict', repair: false, tenantIds: [tenantId] }
  });
  assert.equal(res.res.status, 409);
  assert.ok(res.payload?.error);
});

test('Ledger reconcile repair fixes drift and clears mismatches', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});
  const sellable = defaults.SELLABLE;
  const itemId = await seedItemAndStock(token, sellable.id, 10);

  await db.query(
    `UPDATE inventory_balance
        SET on_hand = on_hand + 5
      WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4`,
    [tenantId, itemId, sellable.id, 'each']
  );

  const res = await apiRequest('POST', '/admin/inventory-ledger/reconcile', {
    token,
    body: { mode: 'strict', repair: true, tenantIds: [tenantId], maxRepairRows: 10 }
  });
  assert.equal(res.res.status, 200);
  const summary = res.payload?.data?.[0];
  assert.ok(summary);
  assert.ok(summary.repairedCount >= 1);

  const balanceRes = await db.query(
    `SELECT on_hand FROM inventory_balance
      WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4`,
    [tenantId, itemId, sellable.id, 'each']
  );
  assert.equal(balanceRes.rowCount, 1);
  assert.ok(Math.abs(Number(balanceRes.rows[0].on_hand) - 10) < 1e-6);
});

test('Ledger reconcile repair aborts when threshold exceeded', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});
  const sellable = defaults.SELLABLE;
  const itemId = await seedItemAndStock(token, sellable.id, 10);

  await db.query(
    `UPDATE inventory_balance
        SET on_hand = on_hand + 5
      WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4`,
    [tenantId, itemId, sellable.id, 'each']
  );

  const res = await apiRequest('POST', '/admin/inventory-ledger/reconcile', {
    token,
    body: { mode: 'strict', repair: true, tenantIds: [tenantId], maxRepairRows: 0 }
  });
  assert.equal(res.res.status, 409);
  assert.ok(res.payload?.error);
});
