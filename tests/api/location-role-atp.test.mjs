import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || `ci-admin+${randomUUID().slice(0,8)}@example.com`;
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = process.env.SEED_TENANT_SLUG || `default-${randomUUID().slice(0,8)}`;

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

function isDescendant(location, warehouseId, byId) {
  let current = location;
  const visited = new Set();
  let depth = 0;
  while (current && current.parentLocationId) {
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    if (current.parentLocationId === warehouseId) return true;
    current = byId.get(current.parentLocationId);
    depth += 1;
    if (depth > 20) return false;
  }
  return false;
}

function formatLocation(location) {
  if (!location) return null;
  return {
    id: location.id,
    code: location.code,
    name: location.name,
    type: location.type,
    role: location.role,
    parentLocationId: location.parentLocationId
  };
}

async function ensureSession() {
  const bootstrapBody = {
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Location Role Tenant',
  };
  const bootstrap = await apiRequest('POST', '/auth/bootstrap', { body: bootstrapBody });
  if (bootstrap.res.ok) return bootstrap.payload;
  assertOk(bootstrap.res, 'POST /auth/bootstrap', bootstrap.payload, bootstrapBody, [200, 201, 409]);

  const loginBody = { email: adminEmail, password: adminPassword, tenantSlug };
  const login = await apiRequest('POST', '/auth/login', { body: loginBody });
  assertOk(login.res, 'POST /auth/login', login.payload, loginBody, [200]);
  return login.payload;
}

async function ensureWarehouseWithSellable(token, tenantId) {
  const locationsRes = await apiRequest('GET', '/locations', { token, params: { limit: 200 } });
  assert.equal(locationsRes.res.status, 200);
  let locations = locationsRes.payload.data || [];
  let warehouse = locations.find((loc) => loc.type === 'warehouse');
  if (!warehouse) {
    const code = `WH-${Date.now()}`;
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
    const code = `SELL-${Date.now()}`;
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
    sellable = createRes.payload;
  }
  assert.ok(tenantId);
  await pool.query(
    `INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
     VALUES ($1, $2, 'SELLABLE', $3)
     ON CONFLICT DO NOTHING`,
    [tenantId, warehouse.id, sellable.id]
  );
  const defaultsRes = await pool.query(
    `SELECT location_id
       FROM warehouse_default_location
      WHERE tenant_id = $1 AND warehouse_id = $2 AND role = 'SELLABLE'`,
    [tenantId, warehouse.id]
  );
  const defaultSellableId = defaultsRes.rows[0]?.location_id;
  if (!defaultSellableId) {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID default_sellable\n${safeJson({ warehouseId: warehouse.id })}`);
  }
  const byId = new Map(locations.map((loc) => [loc.id, loc]));
  const diagnostics = {
    warehouseId: warehouse.id,
    warehouse: formatLocation(warehouse),
    sellable: formatLocation(sellable),
    locations: locations.map(formatLocation)
  };
  if (warehouse.parentLocationId !== null || warehouse.type !== 'warehouse') {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID root\n${safeJson(diagnostics)}`);
  }
  if (!sellable.parentLocationId || !isDescendant(sellable, warehouse.id, byId)) {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID sellable\n${safeJson(diagnostics)}`);
  }
  const defaultSellable = locations.find((loc) => loc.id === defaultSellableId);
  if (!defaultSellable || !isDescendant(defaultSellable, warehouse.id, byId)) {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID default_sellable\n${safeJson(diagnostics)}`);
  }
  return { sellable };
}

test('ATP respects location role and sellable flag', async (t) => {
  t.after(async () => {
    await pool.end();
  });
  const session = await ensureSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { sellable: fgLocation } = await ensureWarehouseWithSellable(token, tenantId);
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
      isSellable: false,
      parentLocationId: locRes.payload.parentLocationId
    }
  });
  assertOk(updateRes.res, 'PUT /locations/:id (set QA)', updateRes.payload, {
    id: locationId,
    role: 'QA',
    isSellable: false,
    parentLocationId: locRes.payload.parentLocationId
  }, [200]);

  const atpRes2 = await apiRequest('GET', '/atp/detail', {
    token,
    params: { itemId, locationId }
  });
  assert.equal(atpRes2.res.status, 404);
});
