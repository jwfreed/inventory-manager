import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSession } from './helpers/ensureSession.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

async function apiRequest(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { res, payload };
}

function assertOk(result, label, allowed = [200, 201]) {
  if (!allowed.includes(result.res.status)) {
    throw new Error(`${label} failed status=${result.res.status} body=${JSON.stringify(result.payload)}`);
  }
}

test('location API exposes and updates inventory behavior fields', async () => {
  const session = await ensureSession({
    tenantSlug: process.env.SEED_TENANT_SLUG || 'default',
    tenantName: 'Location Inventory Behavior'
  });
  const token = session.accessToken;

  const warehouseBody = {
    code: `WH-${randomUUID().slice(0, 8)}`,
    name: 'Behavior Warehouse',
    type: 'warehouse',
    role: null,
    isSellable: false,
    parentLocationId: null,
    active: true
  };
  const warehouse = await apiRequest('POST', '/locations', { token, body: warehouseBody });
  assertOk(warehouse, 'POST /locations warehouse');

  const locationBody = {
    code: `FG-${randomUUID().slice(0, 8)}`,
    name: 'Finished Goods Behavior Bin',
    type: 'bin',
    role: 'FG_SELLABLE',
    isSellable: true,
    parentLocationId: warehouse.payload.id,
    active: true
  };
  const created = await apiRequest('POST', '/locations', { token, body: locationBody });
  assertOk(created, 'POST /locations behavior location');
  assert.equal(created.payload.role, 'FG_SELLABLE');
  assert.equal(created.payload.isSellable, true);

  const fetched = await apiRequest('GET', `/locations/${created.payload.id}`, { token });
  assertOk(fetched, 'GET /locations/:id');
  assert.equal(fetched.payload.role, 'FG_SELLABLE');
  assert.equal(fetched.payload.isSellable, true);

  const updateBody = {
    code: created.payload.code,
    name: created.payload.name,
    type: created.payload.type,
    role: 'PACKAGING',
    isSellable: false,
    parentLocationId: created.payload.parentLocationId,
    active: true
  };
  const updated = await apiRequest('PUT', `/locations/${created.payload.id}`, { token, body: updateBody });
  assertOk(updated, 'PUT /locations/:id');
  assert.equal(updated.payload.role, 'PACKAGING');
  assert.equal(updated.payload.isSellable, false);
});
