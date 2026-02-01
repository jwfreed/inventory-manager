import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `reservation-sellable-${Date.now()}`;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
      tenantName: 'Reservation Sellable Tenant',
    },
  });
  if (bootstrap.res.ok) return bootstrap.payload;
  assert.equal(bootstrap.res.status, 409);

  let login = await apiRequest('POST', '/auth/login', {
    body: { email: adminEmail, password: adminPassword, tenantSlug },
  });
  if (login.res.status === 400) {
    const userRes = await pool.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [adminEmail]);
    const userId = userRes.rows[0]?.id;
    if (!userId) {
      throw new Error('Login failed: user not found');
    }
    const tenantRes = await pool.query('SELECT id FROM tenants WHERE slug = $1', [tenantSlug]);
    let tenantId = tenantRes.rows[0]?.id;
    if (!tenantId) {
      tenantId = randomUUID();
      await pool.query(
        `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
         VALUES ($1, $2, $3, NULL, now())`,
        [tenantId, 'Reservation Sellable Tenant', tenantSlug]
      );
    }
    await pool.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status, created_at)
       VALUES ($1, $2, $3, 'admin', 'active', now())
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [randomUUID(), tenantId, userId]
    );
    login = await apiRequest('POST', '/auth/login', {
      body: { email: adminEmail, password: adminPassword, tenantSlug },
    });
  }
  assert.equal(login.res.status, 200);
  return login.payload;
}

test('reservations require sellable locations', async (t) => {
  t.after(async () => {
    await pool.end();
  });
  const session = await ensureSession();
  const token = session.accessToken;
  assert.ok(token);

  await apiRequest('POST', '/locations/templates/standard-warehouse', {
    token,
    body: { includeReceivingQc: true },
  });

  const locationsRes = await apiRequest('GET', '/locations', { token, params: { limit: 200 } });
  assert.equal(locationsRes.res.status, 200);
  const locations = locationsRes.payload.data || [];
  const qaLocation = locations.find((loc) => loc.role === 'QA') || locations.find((loc) => loc.code === 'QC');
  const sellableLocation = locations.find((loc) => loc.role === 'SELLABLE') || locations.find((loc) => loc.code === 'FG');
  assert.ok(qaLocation, 'QA location required');
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
        { lineNumber: 1, itemId, locationId: qaLocation.id, uom: 'each', quantityDelta: 5, reasonCode: 'seed' },
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
          locationId: qaLocation.id,
          uom: 'each',
          quantityReserved: 1,
        },
      ],
    },
  });
  assert.ok([400, 409].includes(qaReservation.res.status));

  const sellableReservation = await apiRequest('POST', '/reservations', {
    token,
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId,
          locationId: sellableLocation.id,
          uom: 'each',
          quantityReserved: 1,
        },
      ],
    },
  });
  assert.equal(sellableReservation.res.status, 201);
  assert.ok((sellableReservation.payload.data || []).length > 0);
});
