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
  const session = await ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: 'Location Role Tenant'
  });
  db = session.pool;
  return session;
}


test('ATP respects location role and sellable flag', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { defaults } = await ensureStandardWarehouse({ token, tenantId, apiRequest, scope: import.meta.url});
  const fgLocation = defaults.SELLABLE;
  assert.ok(fgLocation);

  const locRes = await apiRequest('POST', '/locations', {
    token,
    body: {
      code: `QA-${Date.now()}`,
      name: 'QA Zone',
      type: 'bin',
      parentLocationId: fgLocation.id,
      role: 'SELLABLE',
      isSellable: true
    }
  });
  assert.equal(locRes.res.status, 201);
  const locationId = locRes.payload.id;

  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `ROLE-${Date.now()}`,
      name: 'Role Test Item',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: locationId
    }
  });
  assert.equal(itemRes.res.status, 201);
  const itemId = itemRes.payload.id;

  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      lines: [
        { lineNumber: 1, itemId, locationId, uom: 'each', quantityDelta: 10, reasonCode: 'test' }
      ]
    }
  });
  assert.equal(adjustmentRes.res.status, 201);

  const postRes = await apiRequest('POST', `/inventory-adjustments/${adjustmentRes.payload.id}/post`, { token });
  assert.equal(postRes.res.status, 200);

  const atpRes1 = await apiRequest('GET', '/atp/detail', {
    token,
    params: { itemId, locationId }
  });
  assert.equal(atpRes1.res.status, 200);

  const updateRes = await apiRequest('PUT', `/locations/${locationId}`, {
    token,
    body: {
      code: locRes.payload.code,
      name: locRes.payload.name,
      type: locRes.payload.type,
      role: 'QA',
      isSellable: false,
      parentLocationId: locRes.payload.parentLocationId
    }
  });
  assertOk(updateRes.res, 'PUT /locations/:id (set QA)', updateRes.payload, {
    id: locationId,
    role: 'QA',
    isSellable: false,
    parentLocationId: locRes.payload.parentLocationId
  }, [200]);

  const atpRes2 = await apiRequest('GET', '/atp/detail', {
    token,
    params: { itemId, locationId }
  });
  assert.equal(atpRes2.res.status, 404);
});
