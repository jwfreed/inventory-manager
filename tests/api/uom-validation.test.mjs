import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSession } from './helpers/ensureSession.mjs';
import { ensureStandardWarehouse } from './helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `uom-validation-${randomUUID().slice(0, 8)}`;

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
    tenantName: 'UOM Validation Tenant',
  });
  return session.accessToken;
}

test('inventory adjustment validation rejects blank uom with UOM_REQUIRED', async () => {
  const token = await getSession();
  const unique = Date.now();

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const locationId = defaults.SELLABLE.id;

  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `UOM-ITEM-${unique}`,
      name: 'UOM Validation Item',
      type: 'finished',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: locationId,
    },
  });
  assert.equal(itemRes.res.status, 201, JSON.stringify(itemRes.payload));

  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      notes: 'Whitespace UOM should fail validation',
      lines: [
        {
          lineNumber: 1,
          itemId: itemRes.payload.id,
          locationId,
          uom: '   ',
          quantityDelta: 1,
          reasonCode: 'correction',
        },
      ],
    },
  });

  assert.equal(adjustmentRes.res.status, 400, JSON.stringify(adjustmentRes.payload));
  assert.match(JSON.stringify(adjustmentRes.payload), /UOM_REQUIRED/);
});
