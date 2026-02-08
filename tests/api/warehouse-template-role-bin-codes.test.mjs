import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSession } from './helpers/ensureSession.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

async function apiRequest(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
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

async function fetchLocationMap(db, tenantId) {
  const res = await db.query(
    `SELECT id, parent_location_id, role, type
       FROM locations
      WHERE tenant_id = $1`,
    [tenantId]
  );
  return new Map(res.rows.map((row) => [row.id, row]));
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

test('standard warehouse template creates role bins even with conflicting codes', async () => {
  const tenantSlug = `tmpl-codes-${randomUUID().slice(0, 8)}`;
  const session = await ensureSession({
    tenantSlug,
    tenantName: 'Template Role Bin Codes'
  });
  const db = session.pool;
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(tenantId, 'tenantId is required');

  const warehouseId = randomUUID();
  const now = new Date();
  await db.query(
    `INSERT INTO locations (
        id, tenant_id, code, name, type, role, is_sellable, active, parent_location_id, warehouse_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, NULL, false, true, NULL, $6, $7, $7)`,
    [warehouseId, tenantId, `ROOT-${warehouseId.slice(0, 8)}`, 'Root', 'warehouse', warehouseId, now]
  );

  const existingQa = await db.query(
    `SELECT id FROM locations WHERE code = 'QA' LIMIT 1`
  );
  if ((existingQa.rowCount ?? 0) === 0) {
    const otherTenantId = randomUUID();
    await db.query(
      `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
       VALUES ($1, $2, $3, NULL, now())`,
      [otherTenantId, 'Template Role Bin Codes Other', `tmpl-codes-other-${randomUUID().slice(0, 8)}`]
    );
    const otherWarehouseId = randomUUID();
    await db.query(
      `INSERT INTO locations (
          id, tenant_id, code, name, type, role, is_sellable, active, parent_location_id, warehouse_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, NULL, false, true, NULL, $6, $7, $7)`,
      [otherWarehouseId, otherTenantId, `ROOT-${otherWarehouseId.slice(0, 8)}`, 'Other Root', 'warehouse', otherWarehouseId, now]
    );
    await db.query(
      `INSERT INTO locations (
          id, tenant_id, code, name, type, role, is_sellable, active, parent_location_id, warehouse_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, false, true, $7, $8, $9, $9)`,
      [
        randomUUID(),
        otherTenantId,
        'QA',
        'Conflicting QA Code',
        'bin',
        'QA',
        otherWarehouseId,
        otherWarehouseId,
        now
      ]
    );
  }

  const first = await apiRequest('POST', '/locations/templates/standard-warehouse', {
    token,
    body: { includeReceivingQc: true }
  });
  assertOk(first.res, 'POST /locations/templates/standard-warehouse (first)', first.payload, {
    includeReceivingQc: true
  });

  const qaRes = await db.query(
    `SELECT id, code
       FROM locations
      WHERE tenant_id = $1
        AND parent_location_id = $2
        AND warehouse_id = $2
        AND role = 'QA'`,
    [tenantId, warehouseId]
  );
  assert.equal(qaRes.rowCount, 1, 'expected exactly one QA role bin under warehouse root');

  const roles = ['SELLABLE', 'QA'];
  const defaultsRes = await db.query(
    `SELECT role, location_id
       FROM warehouse_default_location
      WHERE tenant_id = $1 AND warehouse_id = $2 AND role = ANY($3::text[])`,
    [tenantId, warehouseId, roles]
  );
  const byId = await fetchLocationMap(db, tenantId);
  for (const role of roles) {
    const row = defaultsRes.rows.find((entry) => entry.role === role);
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

  const qaResAfter = await db.query(
    `SELECT id
       FROM locations
      WHERE tenant_id = $1
        AND parent_location_id = $2
        AND warehouse_id = $2
        AND role = 'QA'`,
    [tenantId, warehouseId]
  );
  assert.equal(qaResAfter.rowCount, 1, 'expected exactly one QA role bin after re-run');
});
