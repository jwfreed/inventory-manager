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
    throw new Error(`REQUEST_FAILED ${label} status=${res.status} body=${body}${req ? ` request=${req}` : ''}`);
  }
}

async function getSession() {
  return ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Warehouse Defaults Tenant'
  });
}

async function fetchWarehouseId(tenantId) {
  const res = await db.query(
    `SELECT id FROM locations
      WHERE tenant_id = $1 AND type = 'warehouse'
      ORDER BY created_at ASC
      LIMIT 1`,
    [tenantId]
  );
  return res.rows[0]?.id ?? null;
}

async function fetchWarehouseRow(tenantId, warehouseId) {
  const res = await db.query(
    `SELECT id, type, role, is_sellable, parent_location_id
       FROM locations
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, warehouseId]
  );
  return res.rows[0] ?? null;
}

async function fetchLocationMap(tenantId) {
  const res = await db.query(
    `SELECT id, parent_location_id, role, type
       FROM locations
      WHERE tenant_id = $1`,
    [tenantId]
  );
  const byId = new Map(res.rows.map((row) => [row.id, row]));
  return byId;
}

function isDescendant(locationId, warehouseId, byId) {
  let current = byId.get(locationId);
  const visited = new Set();
  let depth = 0;
  while (current && current.parent_location_id) {
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    if (current.parent_location_id === warehouseId) return true;
    current = byId.get(current.parent_location_id);
    depth += 1;
    if (depth > 50) return false;
  }
  return false;
}

async function fetchDefaults(tenantId, warehouseId, roles) {
  const res = await db.query(
    `SELECT role, location_id
       FROM warehouse_default_location
      WHERE tenant_id = $1 AND warehouse_id = $2 AND role = ANY($3::text[])`,
    [tenantId, warehouseId, roles]
  );
  return res.rows;
}

test('warehouse bootstrap creates defaults and is idempotent', async () => {
  const session = await getSession();
  db = session.pool;
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(tenantId, 'tenantId is required');

  const first = await apiRequest('POST', '/locations/templates/standard-warehouse', {
    token,
    body: { includeReceivingQc: true }
  });
  assertOk(first.res, 'POST /locations/templates/standard-warehouse (first)', first.payload, {
    includeReceivingQc: true
  });

  const warehouseId = await fetchWarehouseId(tenantId);
  assert.ok(warehouseId, 'warehouseId is required');
  const warehouseRow = await fetchWarehouseRow(tenantId, warehouseId);
  assert.ok(warehouseRow, 'warehouse row is required');
  assert.equal(warehouseRow.type, 'warehouse');
  assert.equal(warehouseRow.role, null);
  assert.equal(warehouseRow.is_sellable, false);
  assert.equal(warehouseRow.parent_location_id, null);

  const roles = ['SELLABLE', 'QA'];
  let defaults = await fetchDefaults(tenantId, warehouseId, roles);
  const byId = await fetchLocationMap(tenantId);

  for (const role of roles) {
    const row = defaults.find((entry) => entry.role === role);
    assert.ok(row?.location_id, `default ${role} missing`);
    assert.ok(isDescendant(row.location_id, warehouseId, byId), `default ${role} not under warehouse`);
  }

  const second = await apiRequest('POST', '/locations/templates/standard-warehouse', {
    token,
    body: { includeReceivingQc: true }
  });
  assertOk(second.res, 'POST /locations/templates/standard-warehouse (second)', second.payload, {
    includeReceivingQc: true
  });

  defaults = await fetchDefaults(tenantId, warehouseId, roles);
  const byIdAfter = await fetchLocationMap(tenantId);
  for (const role of roles) {
    const row = defaults.find((entry) => entry.role === role);
    assert.ok(row?.location_id, `default ${role} missing after re-run`);
    assert.ok(
      isDescendant(row.location_id, warehouseId, byIdAfter),
      `default ${role} not under warehouse after re-run`
    );
  }
});
