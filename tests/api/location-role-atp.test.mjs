import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = process.env.SEED_TENANT_SLUG || 'default';

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

async function ensureSession() {
  const bootstrap = await apiRequest('POST', '/auth/bootstrap', {
    body: {
      adminEmail,
      adminPassword,
      tenantSlug,
      tenantName: 'Location Role Tenant',
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

test('ATP respects location role and sellable flag', async () => {
  const session = await ensureSession();
  const token = session.accessToken;
  assert.ok(token);

  await apiRequest('POST', '/locations/templates/standard-warehouse', {
    token,
    body: { includeReceivingQc: true }
  });

  const fgRes = await apiRequest('GET', '/locations', { token, params: { limit: 200 } });
  assert.equal(fgRes.res.status, 200);
  const fgLocation =
    (fgRes.payload.data || []).find((loc) => loc.role === 'SELLABLE') ||
    (fgRes.payload.data || []).find((loc) => loc.code === 'FG');
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
      isSellable: false
    }
  });
  assert.equal(updateRes.res.status, 200);

  const atpRes2 = await apiRequest('GET', '/atp/detail', {
    token,
    params: { itemId, locationId }
  });
  assert.equal(atpRes2.res.status, 404);
});
