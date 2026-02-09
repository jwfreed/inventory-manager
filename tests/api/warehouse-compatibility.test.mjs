import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSession } from './helpers/ensureSession.mjs';
import { ensureStandardWarehouse } from './helpers/warehouse-bootstrap.mjs';

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

async function getSession() {
  return ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: 'Warehouse Compat Tenant'
  });
}

test('warehouse listing includes zones when requested', async (t) => {
  const session = await getSession();
  db = session.pool;
  const token = session.accessToken;
  assert.ok(token);

  await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});

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
