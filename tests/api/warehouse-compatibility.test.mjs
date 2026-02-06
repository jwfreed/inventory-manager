import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `warehouse-compat-${Date.now()}`;

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

async function ensureSession() {
  const bootstrapBody = {
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Warehouse Compat Tenant',
  };
  const bootstrap = await apiRequest('POST', '/auth/bootstrap', { body: bootstrapBody });
  if (bootstrap.res.ok) return bootstrap.payload;
  assertOk(bootstrap.res, 'POST /auth/bootstrap', bootstrap.payload, bootstrapBody, [200, 201, 409]);

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
        [tenantId, 'Warehouse Compat Tenant', tenantSlug]
      );
    }
    await pool.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status, created_at)
       VALUES ($1, $2, $3, 'admin', 'active', now())
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [randomUUID(), tenantId, userId]
    );
    const loginBody = { email: adminEmail, password: adminPassword, tenantSlug };
    login = await apiRequest('POST', '/auth/login', { body: loginBody });
  }
  assertOk(login.res, 'POST /auth/login', login.payload, { email: adminEmail, tenantSlug }, [200]);
  return login.payload;
}

test('warehouse listing includes zones when requested', async (t) => {
  t.after(async () => {
    await pool.end();
  });
  const session = await ensureSession();
  const token = session.accessToken;
  assert.ok(token);

  const locationsRes = await apiRequest('GET', '/locations', { token, params: { limit: 200 } });
  assert.equal(locationsRes.res.status, 200);
  let locations = locationsRes.payload.data || [];
  let warehouse = locations.find((loc) => loc.type === 'warehouse');
  if (!warehouse) {
    const code = `WH-${randomUUID()}`;
    const body = {
      code,
      name: `Warehouse ${code}`,
      type: 'warehouse',
      role: 'SELLABLE',
      isSellable: true,
      active: true
    };
    const createRes = await apiRequest('POST', '/locations', { token, body });
    assertOk(createRes.res, 'POST /locations (warehouse)', createRes.payload, body, [201]);
    warehouse = createRes.payload;
    locations = [...locations, warehouse];
  }
  const zone = locations.find(
    (loc) => loc.type === 'bin' && loc.parentLocationId === warehouse.id
  );
  if (!zone) {
    const code = `ZONE-${randomUUID().slice(0, 8)}`;
    const body = {
      code,
      name: 'Zone Bin',
      type: 'bin',
      role: 'SELLABLE',
      isSellable: true,
      parentLocationId: warehouse.id
    };
    const zoneRes = await apiRequest('POST', '/locations', { token, body });
    assertOk(zoneRes.res, 'POST /locations (zone)', zoneRes.payload, body, [201]);
  }
  if (warehouse.parentLocationId !== null || warehouse.type !== 'warehouse') {
    const diagnostics = {
      warehouseId: warehouse.id,
      warehouse: {
        id: warehouse.id,
        code: warehouse.code,
        name: warehouse.name,
        type: warehouse.type,
        role: warehouse.role,
        parentLocationId: warehouse.parentLocationId
      },
      locations: locations.map((loc) => ({
        id: loc.id,
        code: loc.code,
        name: loc.name,
        type: loc.type,
        role: loc.role,
        parentLocationId: loc.parentLocationId
      }))
    };
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID root\n${safeJson(diagnostics)}`);
  }

  const res = await apiRequest('GET', '/locations', {
    token,
    params: { type: 'warehouse', includeWarehouseZones: true, limit: 200 },
  });
  assert.equal(res.res.status, 200);
  const rows = res.payload.data || [];
  assert.ok(rows.length > 0);
  const hasWarehouse = rows.some((loc) => loc.type === 'warehouse');
  const hasZone = rows.some((loc) => loc.type === 'bin' && loc.parentLocationId);
  assert.ok(hasWarehouse, 'Expected at least one warehouse location');
  assert.ok(hasZone, 'Expected at least one warehouse zone/bin location');
});
