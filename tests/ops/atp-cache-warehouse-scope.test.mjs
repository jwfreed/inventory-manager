import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `atp-cache-scope-${randomUUID().slice(0, 8)}`;

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
  return ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'ATP Cache Warehouse Scope Tenant'
  });
}

async function createWarehouseWithSellable(token, codePrefix) {
  const warehouseRes = await apiRequest('POST', '/locations', {
    token,
    body: {
      code: `${codePrefix}-WH`,
      name: `${codePrefix} Warehouse`,
      type: 'warehouse',
      active: true
    }
  });
  assert.equal(warehouseRes.res.status, 201, JSON.stringify(warehouseRes.payload));

  const sellableRes = await apiRequest('POST', '/locations', {
    token,
    body: {
      code: `${codePrefix}-SELLABLE`,
      name: `${codePrefix} Sellable`,
      type: 'bin',
      role: 'SELLABLE',
      isSellable: true,
      active: true,
      parentLocationId: warehouseRes.payload.id
    }
  });
  assert.equal(sellableRes.res.status, 201, JSON.stringify(sellableRes.payload));

  return { warehouse: warehouseRes.payload, sellable: sellableRes.payload };
}

async function createItem(token, defaultLocationId) {
  const sku = `ATP-CACHE-${randomUUID().slice(0, 8)}`;
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
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function postAdjustment(token, { itemId, locationId, quantityDelta }) {
  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      reasonCode: 'seed',
      lines: [{ lineNumber: 1, itemId, locationId, uom: 'each', quantityDelta, reasonCode: 'seed' }]
    }
  });
  assert.equal(adjustmentRes.res.status, 201, JSON.stringify(adjustmentRes.payload));
  const postRes = await apiRequest('POST', `/inventory-adjustments/${adjustmentRes.payload.id}/post`, {
    token,
    body: {}
  });
  assert.equal(postRes.res.status, 200, JSON.stringify(postRes.payload));
}

function totalAvailable(rows) {
  return (rows || []).reduce((sum, row) => sum + Number(row.availableToPromise || 0), 0);
}

test('ATP cache is warehouse scoped and cannot leak across warehouses', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const factory = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const store = await createWarehouseWithSellable(token, `STORE-${randomUUID().slice(0, 6)}`);
  const itemId = await createItem(token, factory.defaults.SELLABLE.id);

  await postAdjustment(token, {
    itemId,
    locationId: factory.defaults.SELLABLE.id,
    quantityDelta: 7
  });

  const factoryAtp = await apiRequest('GET', '/atp', {
    token,
    params: { warehouseId: factory.warehouse.id, itemId }
  });
  assert.equal(factoryAtp.res.status, 200, JSON.stringify(factoryAtp.payload));
  assert.ok(Math.abs(totalAvailable(factoryAtp.payload?.data) - 7) < 1e-6);

  const storeAtp = await apiRequest('GET', '/atp', {
    token,
    params: { warehouseId: store.warehouse.id, itemId }
  });
  assert.equal(storeAtp.res.status, 200, JSON.stringify(storeAtp.payload));
  assert.ok(Math.abs(totalAvailable(storeAtp.payload?.data) - 0) < 1e-6);
});
