import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSession } from './helpers/ensureSession.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = process.env.SEED_TENANT_SLUG || 'default';
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
    parentLocationId: location.parentLocationId
  };
}

async function bootstrapWarehouseGraph(token, tenantId, db, options = {}) {
  const {
    requireSellable = true,
    requireQA = true,
    requireDefaultsFor = []
  } = options;
  assert.ok(tenantId);

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
      role: null,
      isSellable: false,
      active: true
    };
    const createRes = await apiRequest('POST', '/locations', { token, body });
    assertOk(createRes.res, 'POST /locations (warehouse)', createRes.payload, body, [201]);
    warehouse = createRes.payload;
    locations = [...locations, warehouse];
  }

  const ensureRole = async (role) => {
    let loc = locations.find(
      (entry) => entry.role === role && entry.parentLocationId === warehouse.id
    );
    if (!loc) {
      const code = `${role}-${randomUUID().slice(0, 8)}`;
      const body = {
        code,
        name: `${role} Location`,
        type: 'bin',
        role,
        isSellable: role === 'SELLABLE',
        parentLocationId: warehouse.id
      };
      const createRes = await apiRequest('POST', '/locations', { token, body });
      assertOk(createRes.res, `POST /locations (${role})`, createRes.payload, body, [201]);
      loc = createRes.payload;
      locations = [...locations, loc];
    }
    return loc;
  };

  const qaLocation = requireQA ? await ensureRole('QA') : null;
  const sellableLocation = requireSellable ? await ensureRole('SELLABLE') : null;

  const defaultsRequired = Array.isArray(requireDefaultsFor) ? requireDefaultsFor : [];
  for (const role of defaultsRequired) {
    const locationId =
      role === 'QA'
        ? qaLocation?.id
        : role === 'SELLABLE'
          ? sellableLocation?.id
          : null;
    if (!locationId) {
      throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID default_${role.toLowerCase()}_missing_location`);
    }
    await db.query(
      `INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [tenantId, warehouse.id, role, locationId]
    );
  }

  const byId = new Map(locations.map((loc) => [loc.id, loc]));
  const defaultsRes = defaultsRequired.length
    ? await db.query(
        `SELECT role, location_id
           FROM warehouse_default_location
          WHERE tenant_id = $1 AND warehouse_id = $2 AND role = ANY($3::text[])`,
        [tenantId, warehouse.id, defaultsRequired]
      )
    : { rows: [] };
  const defaults = new Map(defaultsRes.rows.map((row) => [row.role, row.location_id]));
  const diagnostics = {
    warehouseId: warehouse.id,
    warehouse: formatLocation(warehouse),
    qaLocation: formatLocation(qaLocation),
    sellableLocation: formatLocation(sellableLocation),
    locations: locations.map(formatLocation),
    defaults: defaultsRes.rows
  };

  if (warehouse.parentLocationId !== null || warehouse.type !== 'warehouse') {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID root\n${safeJson(diagnostics)}`);
  }
  if (requireQA) {
    if (!qaLocation?.parentLocationId || !isDescendant(qaLocation, warehouse.id, byId)) {
      throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID qa\n${safeJson(diagnostics)}`);
    }
  }
  if (requireSellable) {
    if (!sellableLocation?.parentLocationId || !isDescendant(sellableLocation, warehouse.id, byId)) {
      throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID sellable\n${safeJson(diagnostics)}`);
    }
  }
  for (const role of defaultsRequired) {
    const defaultLocationId = defaults.get(role);
    if (!defaultLocationId) {
      throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID default_${role.toLowerCase()}\n${safeJson(diagnostics)}`);
    }
    const defaultLocation = locations.find((loc) => loc.id === defaultLocationId);
    if (!defaultLocation || !isDescendant(defaultLocation, warehouse.id, byId)) {
      throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID default_${role.toLowerCase()}\n${safeJson(diagnostics)}`);
    }
  }

  return { warehouse, qaLocation, sellableLocation, locations };
}

async function getSession() {
  const session = await ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: 'Reservation Sellable Tenant'
  });
  db = session.pool;
  return session;
}

test('reservations require sellable locations', async (t) => {
  const session = await getSession();
  const token = session.accessToken;
  assert.ok(token);
  const { qaLocation, sellableLocation } = await bootstrapWarehouseGraph(
    token,
    session.tenant?.id,
    session.pool,
    {
      requireSellable: true,
      requireQA: true,
      requireDefaultsFor: []
    }
  );
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
