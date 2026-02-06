import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `cost-layer-concurrency-${Date.now()}`;

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
    tenantName: 'Cost Layer Concurrency Tenant',
  };
  const bootstrap = await apiRequest('POST', '/auth/bootstrap', { body: bootstrapBody });
  if (bootstrap.res.ok) return bootstrap.payload;
  assertOk(bootstrap.res, 'POST /auth/bootstrap', bootstrap.payload, bootstrapBody, [200, 201, 409]);

  let login = await apiRequest('POST', '/auth/login', {
    body: { email: adminEmail, password: adminPassword, tenantSlug },
  });
  if (login.res.status === 400) {
    const userRes = await pool.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [adminEmail]);
    const baseUserId = userRes.rows[0]?.id;
    assert.ok(baseUserId);
    const tenantRes = await pool.query('SELECT id FROM tenants WHERE slug = $1', [tenantSlug]);
    let tenantId = tenantRes.rows[0]?.id;
    if (!tenantId) {
      tenantId = randomUUID();
      await pool.query(
        `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
         VALUES ($1, $2, $3, NULL, now())`,
        [tenantId, 'Cost Layer Concurrency Tenant', tenantSlug]
      );
    }
    await pool.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status, created_at)
       VALUES ($1, $2, $3, 'admin', 'active', now())
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [randomUUID(), tenantId, baseUserId]
    );
    const loginBody = { email: adminEmail, password: adminPassword, tenantSlug };
    login = await apiRequest('POST', '/auth/login', { body: loginBody });
  }
  assertOk(login.res, 'POST /auth/login', login.payload, { email: adminEmail, tenantSlug }, [200]);
  return login.payload;
}

async function ensureWarehouseRoot(token) {
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
  let sellable = locations.find(
    (loc) => loc.role === 'SELLABLE' && loc.parentLocationId === warehouse.id
  );
  if (!sellable) {
    const code = `SELL-${randomUUID().slice(0, 8)}`;
    const body = {
      code,
      name: 'Sellable Location',
      type: 'bin',
      role: 'SELLABLE',
      isSellable: true,
      parentLocationId: warehouse.id
    };
    const createRes = await apiRequest('POST', '/locations', { token, body });
    assertOk(createRes.res, 'POST /locations (SELLABLE)', createRes.payload, body, [201]);
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
  return warehouse;
}

test('cost layer inserts are concurrency-safe for receipts', async (t) => {
  t.after(async () => {
    await pool.end();
  });

  const session = await ensureSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  await ensureWarehouseRoot(token);

  const locationsRes = await apiRequest('GET', '/locations', { token, params: { limit: 200 } });
  assert.equal(locationsRes.res.status, 200);
  const location = (locationsRes.payload.data || []).find((loc) => loc.role === 'SELLABLE');
  assert.ok(location);

  const sku = `CL-${Date.now()}`;
  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: location.id,
    },
  });
  assert.equal(itemRes.res.status, 201);
  const itemId = itemRes.payload.id;

  const sourceId = randomUUID();
  const insertLayer = () =>
    pool.query(
      `INSERT INTO inventory_cost_layers (
          id, tenant_id, item_id, location_id, uom, layer_date, layer_sequence,
          original_quantity, remaining_quantity, unit_cost, extended_cost,
          source_type, source_document_id, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,now(),1,$6,$6,$7,$8,'receipt',$9,now(),now())
       ON CONFLICT DO NOTHING`,
      [randomUUID(), tenantId, itemId, location.id, 'each', 5, 10, 50, sourceId]
    );

  await Promise.all([insertLayer(), insertLayer()]);

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND source_type = 'receipt'
        AND source_document_id = $2
        AND voided_at IS NULL`,
    [tenantId, sourceId]
  );
  assert.equal(countRes.rows[0].count, 1);
});
