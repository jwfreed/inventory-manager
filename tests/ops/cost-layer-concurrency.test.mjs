import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import { waitForCondition } from '../api/helpers/waitFor.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = process.env.SEED_TENANT_SLUG || `cost-layer-concurrency-${randomUUID().slice(0, 8)}`;
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
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: 'Cost Layer Concurrency Tenant'
  });
  db = session.pool;
  return session;
}


test('cost layer inserts are concurrency-safe for receipts', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});
  const location = defaults.SELLABLE;
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
    db.query(
      `INSERT INTO inventory_cost_layers (
          id, tenant_id, item_id, location_id, uom, layer_date, layer_sequence,
          original_quantity, remaining_quantity, unit_cost, extended_cost,
          source_type, source_document_id, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,now(),1,$6,$6,$7,$8,'receipt',$9,now(),now())
       ON CONFLICT DO NOTHING`,
      [randomUUID(), tenantId, itemId, location.id, 'each', 5, 10, 50, sourceId]
    );

  await Promise.all([insertLayer(), insertLayer()]);

  const activeCount = await waitForCondition(
    async () => {
      const countRes = await db.query(
        `SELECT COUNT(*)::int AS count
           FROM inventory_cost_layers
          WHERE tenant_id = $1
            AND source_type = 'receipt'
            AND source_document_id = $2
            AND voided_at IS NULL`,
        [tenantId, sourceId]
      );
      return countRes.rows[0].count;
    },
    (count) => count === 1,
    { label: 'active receipt cost layers' }
  );
  assert.equal(activeCount, 1);
});
