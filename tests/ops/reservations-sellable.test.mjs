import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSession } from '../api/helpers/ensureSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

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

async function getSession() {
  const session = await ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: 'Reservation Sellable Tenant'
  });
  return session;
}

test('reservations require sellable locations', async () => {
  const session = await getSession();
  const token = session.accessToken;
  assert.ok(token);
  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});
  const nonSellableLocation = defaults.HOLD ?? defaults.QA;
  const sellableLocation = defaults.SELLABLE;
  assert.ok(nonSellableLocation, 'Non-sellable location required');
  assert.ok(sellableLocation, 'Sellable location required');

  const sku = `RES-${Date.now()}`;
  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: sellableLocation.id,
    },
  });
  assert.equal(itemRes.res.status, 201);
  const itemId = itemRes.payload.id;

  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      reasonCode: 'seed',
      lines: [
        { lineNumber: 1, itemId, locationId: nonSellableLocation.id, uom: 'each', quantityDelta: 5, reasonCode: 'seed' },
        { lineNumber: 2, itemId, locationId: sellableLocation.id, uom: 'each', quantityDelta: 5, reasonCode: 'seed' },
      ],
    },
  });
  assert.equal(adjustmentRes.res.status, 201);
  const adjustmentPost = await apiRequest('POST', `/inventory-adjustments/${adjustmentRes.payload.id}/post`, { token });
  assert.equal(adjustmentPost.res.status, 200);

  const qaReservation = await apiRequest('POST', '/reservations', {
    token,
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId,
          warehouseId: warehouse.id,
          locationId: nonSellableLocation.id,
          uom: 'each',
          quantityReserved: 1,
        },
      ],
    },
  });
  if (![400, 409].includes(qaReservation.res.status)) {
    throw new Error(
      `RESERVATION_NON_SELLABLE_FAILED status=${qaReservation.res.status} body=${JSON.stringify(qaReservation.payload)}`
    );
  }

  const sellableReservation = await apiRequest('POST', '/reservations', {
    token,
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId,
          warehouseId: warehouse.id,
          locationId: sellableLocation.id,
          uom: 'each',
          quantityReserved: 1,
        },
      ],
    },
  });
  if (sellableReservation.res.status !== 201) {
    throw new Error(
      `RESERVATION_SELLABLE_FAILED status=${sellableReservation.res.status} body=${JSON.stringify(sellableReservation.payload)}`
    );
  }
  assert.ok((sellableReservation.payload.data || []).length > 0);
});
