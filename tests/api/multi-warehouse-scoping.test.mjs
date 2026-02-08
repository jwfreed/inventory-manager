import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSession } from './helpers/ensureSession.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
let db;


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
    parentLocationId: location.parentLocationId,
  };
}

async function getSession(tenantSlug) {
  const session = await ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: `Multi Warehouse ${tenantSlug}`
  });
  db = session.pool;
  return session;
}

async function createWarehouseGraph(token, tenantId, label) {
  const warehouseCode = `WH-${label}-${randomUUID().slice(0, 8)}`;
  const warehouseBody = {
    code: warehouseCode,
    name: `Warehouse ${label}`,
    type: 'warehouse',
    role: null,
    isSellable: false,
    active: true,
  };
  const createWarehouse = await apiRequest('POST', '/locations', { token, body: warehouseBody });
  assertOk(createWarehouse.res, `POST /locations (warehouse ${label})`, createWarehouse.payload, warehouseBody, [201]);
  const warehouse = createWarehouse.payload;

  const createChild = async (role, isSellable) => {
    const body = {
      code: `${role}-${label}-${randomUUID().slice(0, 8)}`,
      name: `${role} ${label}`,
      type: 'bin',
      role,
      isSellable,
      parentLocationId: warehouse.id,
    };
    const res = await apiRequest('POST', '/locations', { token, body });
    assertOk(res.res, `POST /locations (${role} ${label})`, res.payload, body, [201]);
    return res.payload;
  };

  const qaLocation = await createChild('QA', false);
  const sellableLocation = await createChild('SELLABLE', true);

  await db.query(
    `INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [tenantId, warehouse.id, 'QA', qaLocation.id]
  );
  await db.query(
    `INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [tenantId, warehouse.id, 'SELLABLE', sellableLocation.id]
  );

  return {
    warehouse,
    qaLocation,
    sellableLocation,
    locations: [warehouse, qaLocation, sellableLocation],
  };
}

async function createItem(token, defaultLocationId) {
  const sku = `MW-${randomUUID().slice(0, 8)}`;
  const body = {
    sku,
    name: `Multi Warehouse Item ${sku}`,
    uomDimension: 'count',
    canonicalUom: 'each',
    stockingUom: 'each',
    defaultLocationId,
  };
  const res = await apiRequest('POST', '/items', { token, body });
  assertOk(res.res, 'POST /items', res.payload, body, [201]);
  return res.payload.id;
}

async function seedOnHand(token, itemId, locationId, quantity) {
  const body = {
    occurredAt: new Date().toISOString(),
    lines: [
      {
        lineNumber: 1,
        itemId,
        locationId,
        uom: 'each',
        quantityDelta: quantity,
        reasonCode: 'seed',
      },
    ],
  };
  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', { token, body });
  assertOk(adjustmentRes.res, 'POST /inventory-adjustments', adjustmentRes.payload, body, [201]);
  const postRes = await apiRequest(
    'POST',
    `/inventory-adjustments/${adjustmentRes.payload.id}/post`,
    { token }
  );
  assertOk(postRes.res, 'POST /inventory-adjustments/:id/post', postRes.payload, null, [200]);
}

async function getAtpDetail(token, itemId, locationId, { allowNotFound = false } = {}) {
  const res = await apiRequest('GET', '/atp/detail', {
    token,
    params: { itemId, locationId },
  });
  if (allowNotFound && res.res.status === 404) return null;
  assertOk(res.res, 'GET /atp/detail', res.payload, { itemId, locationId }, [200]);
  return res.payload.data;
}

async function getSnapshot(token, itemId, locationId) {
  const res = await apiRequest('GET', '/inventory-snapshot', {
    token,
    params: { itemId, locationId },
  });
  assertOk(res.res, 'GET /inventory-snapshot', res.payload, { itemId, locationId }, [200]);
  return res.payload.data || [];
}

test('ATP and snapshot are warehouse-scoped', async () => {
  const tenantSlug = process.env.SEED_TENANT_SLUG || 'default';
let db;
  const session = await getSession(tenantSlug);
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const warehouseA = await createWarehouseGraph(token, tenantId, 'A');
  const warehouseB = await createWarehouseGraph(token, tenantId, 'B');

  const itemId = await createItem(token, warehouseA.sellableLocation.id);
  await seedOnHand(token, itemId, warehouseA.sellableLocation.id, 5);

  const atpA = await getAtpDetail(token, itemId, warehouseA.sellableLocation.id);
  assert.ok(Number(atpA.availableToPromise) > 0, safeJson({ atpA }));

  const atpB = await getAtpDetail(token, itemId, warehouseB.sellableLocation.id, { allowNotFound: true });
  if (atpB) {
    assert.ok(Math.abs(Number(atpB.availableToPromise)) < 1e-6, safeJson({ atpB }));
  }

  const snapshotA = await getSnapshot(token, itemId, warehouseA.sellableLocation.id);
  const onHandA = Number(snapshotA[0]?.onHand ?? 0);
  assert.ok(onHandA > 0, safeJson({ snapshotA }));

  const snapshotB = await getSnapshot(token, itemId, warehouseB.sellableLocation.id);
  const onHandB = Number(snapshotB[0]?.onHand ?? 0);
  assert.ok(Math.abs(onHandB) < 1e-6, safeJson({ snapshotB }));
});

test('reservations do not consume supply across warehouses', async () => {
  const tenantSlug = process.env.SEED_TENANT_SLUG || 'default';
  const session = await getSession(tenantSlug);
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const warehouseA = await createWarehouseGraph(token, tenantId, 'A');
  const warehouseB = await createWarehouseGraph(token, tenantId, 'B');

  const itemId = await createItem(token, warehouseA.sellableLocation.id);
  await seedOnHand(token, itemId, warehouseA.sellableLocation.id, 1);

  const preAtpA = await getAtpDetail(token, itemId, warehouseA.sellableLocation.id);
  const preAtpB = await getAtpDetail(token, itemId, warehouseB.sellableLocation.id, { allowNotFound: true });

  const reserveB = await apiRequest('POST', '/reservations', {
    token,
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId,
          locationId: warehouseB.sellableLocation.id,
          uom: 'each',
          quantityReserved: 1,
          allowBackorder: false,
        },
      ],
    },
  });

  const reserveA = await apiRequest('POST', '/reservations', {
    token,
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId,
          locationId: warehouseA.sellableLocation.id,
          uom: 'each',
          quantityReserved: 1,
          allowBackorder: false,
        },
      ],
    },
  });

  if (reserveB.res.status !== 409 || reserveA.res.status !== 201) {
    const diag = {
      preAtpA,
      preAtpB,
      reserveB: { status: reserveB.res.status, payload: reserveB.payload },
      reserveA: { status: reserveA.res.status, payload: reserveA.payload },
      warehouseA: formatLocation(warehouseA.warehouse),
      warehouseB: formatLocation(warehouseB.warehouse),
      sellableA: formatLocation(warehouseA.sellableLocation),
      sellableB: formatLocation(warehouseB.sellableLocation),
    };
    throw new Error(`RESERVATION_WAREHOUSE_SCOPE_INVALID\n${safeJson(diag)}`);
  }
});

test('defaults are warehouse-local', async () => {
  const tenantSlug = process.env.SEED_TENANT_SLUG || 'default';
  const session = await getSession(tenantSlug);
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const warehouseA = await createWarehouseGraph(token, tenantId, 'A');
  const warehouseB = await createWarehouseGraph(token, tenantId, 'B');

  const locationsRes = await apiRequest('GET', '/locations', { token, params: { limit: 200 } });
  assertOk(locationsRes.res, 'GET /locations', locationsRes.payload, null, [200]);
  const locations = locationsRes.payload.data || [];
  const byId = new Map(locations.map((loc) => [loc.id, loc]));

  const defaultsA = await db.query(
    `SELECT role, location_id FROM warehouse_default_location WHERE tenant_id = $1 AND warehouse_id = $2`,
    [tenantId, warehouseA.warehouse.id]
  );
  const defaultsB = await db.query(
    `SELECT role, location_id FROM warehouse_default_location WHERE tenant_id = $1 AND warehouse_id = $2`,
    [tenantId, warehouseB.warehouse.id]
  );

  const validateDefaults = (defaultsRes, warehouse, label) => {
    const diagnostics = {
      warehouse: formatLocation(warehouse),
      defaults: defaultsRes.rows,
      locations: locations.map(formatLocation),
    };
    for (const row of defaultsRes.rows) {
      const location = byId.get(row.location_id);
      if (!location || !isDescendant(location, warehouse.id, byId)) {
        throw new Error(`WAREHOUSE_DEFAULT_SCOPE_INVALID ${label}\n${safeJson(diagnostics)}`);
      }
    }
  };

  validateDefaults(defaultsA, warehouseA.warehouse, 'A');
  validateDefaults(defaultsB, warehouseB.warehouse, 'B');
});
