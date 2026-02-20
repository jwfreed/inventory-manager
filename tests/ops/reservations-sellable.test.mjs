import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSession } from '../api/helpers/ensureSession.mjs';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
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

async function getDbSession() {
  return ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Reservation Sellable Tenant'
  });
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

test('fulfill reservation fails for non-sellable location', async () => {
  const session = await getDbSession();
  const token = session.accessToken;
  const db = session.pool;
  const tenantId = session.tenant.id;
  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:fulfill-non-sellable` });
  const nonSellableLocation = defaults.QA ?? defaults.HOLD;
  const sellableLocation = defaults.SELLABLE;
  assert.ok(nonSellableLocation, 'Non-sellable location required');

  const sku = `RES-FUL-${Date.now()}`;
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
        {
          lineNumber: 1,
          itemId,
          locationId: nonSellableLocation.id,
          uom: 'each',
          quantityDelta: 2,
          reasonCode: 'seed'
        }
      ]
    }
  });
  assert.equal(adjustmentRes.res.status, 201, JSON.stringify(adjustmentRes.payload));
  const adjustmentPost = await apiRequest('POST', `/inventory-adjustments/${adjustmentRes.payload.id}/post`, {
    token,
    body: {}
  });
  assert.equal(adjustmentPost.res.status, 200, JSON.stringify(adjustmentPost.payload));

  const customerId = randomUUID();
  await db.query(
    `INSERT INTO customers (id, tenant_id, code, name, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, now(), now())`,
    [customerId, tenantId, `C-${customerId.slice(0, 8)}`, `Customer ${customerId.slice(0, 6)}`]
  );

  const soRes = await apiRequest('POST', '/sales-orders', {
    token,
    body: {
      soNumber: `SO-${randomUUID().slice(0, 8)}`,
      customerId,
      status: 'submitted',
      warehouseId: warehouse.id,
      shipFromLocationId: nonSellableLocation.id,
      lines: [{ itemId, uom: 'each', quantityOrdered: 1 }]
    }
  });
  assert.equal(soRes.res.status, 201, JSON.stringify(soRes.payload));
  const soLineId = soRes.payload.lines[0].id;

  const shipmentRes = await apiRequest('POST', '/shipments', {
    token,
    body: {
      salesOrderId: soRes.payload.id,
      shippedAt: new Date().toISOString(),
      shipFromLocationId: nonSellableLocation.id,
      lines: [{ salesOrderLineId: soLineId, uom: 'each', quantityShipped: 1 }]
    }
  });
  assert.equal(shipmentRes.res.status, 201, JSON.stringify(shipmentRes.payload));

  const fulfillRes = await apiRequest('POST', `/shipments/${shipmentRes.payload.id}/post`, {
    token,
    headers: { 'Idempotency-Key': `ship-${randomUUID()}` },
    body: {}
  });
  assert.equal(fulfillRes.res.status, 409, JSON.stringify(fulfillRes.payload));
  assert.equal(fulfillRes.payload?.error?.code, 'NON_SELLABLE_LOCATION');
});
