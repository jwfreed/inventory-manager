import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSession } from './helpers/ensureSession.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `uom-registry-${randomUUID().slice(0, 8)}`;
const ENFORCE_UOM_REGISTRY = process.env.ENFORCE_UOM_REGISTRY === 'true';

async function apiRequest(method, path, { token, body, params } = {}) {
  const url = new URL(baseUrl + path);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
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
    tenantSlug,
    tenantName: 'UOM Registry API Tenant',
  });
  return session.accessToken;
}

async function createItem(token, skuSuffix) {
  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `UOM-REG-${skuSuffix}`,
      name: `UOM Registry ${skuSuffix}`,
      type: 'raw',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
    },
  });
  assert.equal(itemRes.res.status, 201, JSON.stringify(itemRes.payload));
  return itemRes.payload.id;
}

test('GET /uoms returns canonical registry list', async () => {
  const token = await getSession();
  const response = await apiRequest('GET', '/uoms', { token });
  assert.equal(response.res.status, 200, JSON.stringify(response.payload));
  assert.ok(Array.isArray(response.payload?.data));
  assert.ok(response.payload.data.some((entry) => entry.code === 'ea'));
  assert.ok(response.payload.data.some((entry) => entry.code === 'kg'));
});

test('POST /uoms/convert supports preview and rejects cross-dimension conversion', async () => {
  const token = await getSession();

  const convertRes = await apiRequest('POST', '/uoms/convert', {
    token,
    body: {
      qty: '1',
      fromUom: 'kg',
      toUom: 'g',
      roundingContext: 'transfer',
    },
  });
  assert.equal(convertRes.res.status, 200, JSON.stringify(convertRes.payload));
  assert.equal(convertRes.payload.qty, '1000');
  assert.equal(convertRes.payload.exactQty, '1000');
  assert.ok(Array.isArray(convertRes.payload.traces));
  assert.equal(convertRes.payload.status, 'OK');
  assert.equal(convertRes.payload.severity, 'info');
  assert.equal(convertRes.payload.canAggregate, true);

  const mismatchRes = await apiRequest('POST', '/uoms/convert', {
    token,
    body: {
      qty: '1',
      fromUom: 'kg',
      toUom: 'l',
      roundingContext: 'transfer',
    },
  });
  assert.equal(mismatchRes.res.status, 400, JSON.stringify(mismatchRes.payload));
  assert.equal(mismatchRes.payload?.error?.code, 'UOM_DIMENSION_MISMATCH');
});

test('PATCH /items/:id/uom updates stock UOM policy and applies registry enforcement when enabled', async () => {
  const token = await getSession();
  const itemId = await createItem(token, Date.now());

  const patchRes = await apiRequest('PATCH', `/items/${itemId}/uom`, {
    token,
    body: {
      uomDimension: 'mass',
      stockingUom: 'kg',
      defaultUom: 'kg',
    },
  });
  assert.equal(patchRes.res.status, 200, JSON.stringify(patchRes.payload));
  assert.equal(patchRes.payload.stockingUom, 'kg');
  assert.equal(patchRes.payload.uomDimension, 'mass');

  const unknownRes = await apiRequest('PATCH', `/items/${itemId}/uom`, {
    token,
    body: {
      uomDimension: 'mass',
      stockingUom: 'unknown_uom_code',
      defaultUom: 'unknown_uom_code',
    },
  });

  if (ENFORCE_UOM_REGISTRY) {
    assert.equal(unknownRes.res.status, 400, JSON.stringify(unknownRes.payload));
    assert.equal(unknownRes.payload?.error?.code, 'UOM_UNKNOWN');
    assert.ok(Array.isArray(unknownRes.payload?.error?.context?.suggestions));
  } else {
    assert.equal(unknownRes.res.status, 200, JSON.stringify(unknownRes.payload));
  }
});

test('POST /uoms/convert returns actionable unknown UOM context when enforcement is enabled', async () => {
  const token = await getSession();
  const response = await apiRequest('POST', '/uoms/convert', {
    token,
    body: {
      qty: '1',
      fromUom: 'unknown_metric_unit',
      toUom: 'g',
      roundingContext: 'transfer',
    },
  });

  if (ENFORCE_UOM_REGISTRY) {
    assert.equal(response.res.status, 400, JSON.stringify(response.payload));
    assert.equal(response.payload?.error?.code, 'UOM_UNKNOWN');
    assert.ok(Array.isArray(response.payload?.error?.context?.suggestions));
  } else {
    assert.notEqual(response.res.status, 500, JSON.stringify(response.payload));
  }
});
