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
    throw new Error(`REQUEST_FAILED ${label} status=${res.status} body=${body}${req ? ` request=${req}` : ''}`);
  }
}

test('POST /locations accepts role-less warehouse roots and rejects sellable roots', async () => {
  const session = await ensureSession({
    tenantSlug: process.env.SEED_TENANT_SLUG || 'default',
    tenantName: 'Warehouse Root Create'
  });
  const token = session.accessToken;

  const warehouseBody = {
    code: `WH-${randomUUID().slice(0, 8)}`,
    name: 'Warehouse Root',
    type: 'warehouse',
    role: null,
    isSellable: false,
    parentLocationId: null,
    active: true
  };

  const created = await apiRequest('POST', '/locations', { token, body: warehouseBody });
  assertOk(created.res, 'POST /locations (warehouse)', created.payload, warehouseBody);
  assert.equal(created.payload?.type, 'warehouse');
  assert.equal(created.payload?.role, null);
  assert.equal(created.payload?.isSellable, false);
  assert.equal(created.payload?.parentLocationId ?? null, null);

  const invalidBody = {
    code: `BAD-${randomUUID().slice(0, 8)}`,
    name: 'Invalid Warehouse Root',
    type: 'warehouse',
    role: 'SELLABLE',
    isSellable: true,
    parentLocationId: null,
    active: true
  };
  const invalid = await apiRequest('POST', '/locations', { token, body: invalidBody });
  assert.equal(invalid.res.status, 400);
});
