import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import { stopTestServer } from '../api/helpers/testServer.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { pruneIdempotencyKeys } = require('../../src/jobs/idempotencyRetention.job.ts');

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const openPools = new Set();

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
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { res, payload };
}

async function createVendor(token) {
  const code = `V-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/vendors', {
    token,
    body: { code, name: `Vendor ${code}` }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createItem(token, locationId) {
  const sku = `RET-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Retention ${sku}`,
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: locationId
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createApprovedPurchaseOrder(token, vendorId, itemId, locationId, quantity, unitCost) {
  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId: locationId,
      receivingLocationId: locationId,
      expectedDate: '2026-02-15',
      status: 'approved',
      lines: [{ itemId, uom: 'each', quantityOrdered: quantity, unitCost, currencyCode: 'THB' }]
    }
  });
  assert.equal(poRes.res.status, 201, JSON.stringify(poRes.payload));
  return poRes.payload;
}

async function withRetentionSettings(retentionDays, batchSize, fn) {
  const priorDays = process.env.IDEMPOTENCY_RETENTION_DAYS;
  const priorBatch = process.env.IDEMPOTENCY_RETENTION_BATCH;
  process.env.IDEMPOTENCY_RETENTION_DAYS = String(retentionDays);
  process.env.IDEMPOTENCY_RETENTION_BATCH = String(batchSize);
  try {
    return await fn();
  } finally {
    if (priorDays === undefined) {
      delete process.env.IDEMPOTENCY_RETENTION_DAYS;
    } else {
      process.env.IDEMPOTENCY_RETENTION_DAYS = priorDays;
    }
    if (priorBatch === undefined) {
      delete process.env.IDEMPOTENCY_RETENTION_BATCH;
    } else {
      process.env.IDEMPOTENCY_RETENTION_BATCH = priorBatch;
    }
  }
}

function hashForKey(prefix, key) {
  return createHash('sha256').update(`${prefix}:${key}`).digest('hex');
}

test.after(async () => {
  await Promise.all(
    Array.from(openPools).map(async (pool) => {
      try {
        await pool.end();
      } catch {
        // ignore teardown failures
      }
    })
  );
  openPools.clear();
  await stopTestServer();
});

test('idempotency retention prunes old keys, keeps fresh keys, and allows re-claim after prune', async () => {
  const tenantSlug = `idem-retention-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Idempotency Retention Safety Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  if (db) openPools.add(db);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, defaults.SELLABLE.id);
  const po = await createApprovedPurchaseOrder(token, vendorId, itemId, defaults.SELLABLE.id, 7, 3.25);

  const oldKey = `idem-ret-old-${randomUUID()}`;
  const freshKey = `idem-ret-fresh-${randomUUID()}`;
  await db.query(
    `INSERT INTO idempotency_keys (
        tenant_id,
        key,
        endpoint,
        request_hash,
        response_status,
        response_body,
        status,
        response_ref,
        updated_at,
        created_at
      ) VALUES
      ($1, $2, 'receipts.post', $3, 200, '{"ok":true}'::jsonb, 'SUCCEEDED', NULL, now() - interval '9 days', now() - interval '9 days'),
      ($1, $4, 'receipts.post', $5, 200, '{"ok":true}'::jsonb, 'SUCCEEDED', NULL, now(), now())`,
    [tenantId, oldKey, hashForKey('old', oldKey), freshKey, hashForKey('fresh', freshKey)]
  );

  const beforePrune = await db.query(
    `SELECT key
       FROM idempotency_keys
      WHERE tenant_id = $1
        AND key = ANY($2::text[])
      ORDER BY key ASC`,
    [tenantId, [oldKey, freshKey]]
  );
  assert.deepEqual(beforePrune.rows.map((row) => row.key), [freshKey, oldKey].sort());

  const pruneResult = await withRetentionSettings(7, 5000, async () => pruneIdempotencyKeys());
  assert.ok(pruneResult.deleted >= 1);
  assert.equal(pruneResult.retentionDays, 7);

  const afterPrune = await db.query(
    `SELECT key
       FROM idempotency_keys
      WHERE tenant_id = $1
        AND key = ANY($2::text[])
      ORDER BY key ASC`,
    [tenantId, [oldKey, freshKey]]
  );
  assert.deepEqual(afterPrune.rows.map((row) => row.key), [freshKey]);

  const postReceipt = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': oldKey },
    body: {
      purchaseOrderId: po.id,
      receivedAt: '2026-02-16T00:00:00.000Z',
      lines: [
        {
          purchaseOrderLineId: po.lines[0].id,
          uom: 'each',
          quantityReceived: 7,
          unitCost: 3.25
        }
      ]
    }
  });
  assert.equal(postReceipt.res.status, 201, JSON.stringify(postReceipt.payload));
  assert.ok(postReceipt.payload?.inventoryMovementId);

  const receiptRows = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM purchase_order_receipts
      WHERE tenant_id = $1
        AND idempotency_key = $2`,
    [tenantId, oldKey]
  );
  assert.equal(Number(receiptRows.rows[0]?.count ?? 0), 1);
});

test('idempotency retention does not delete fresh keys when cutoff excludes all rows', async () => {
  const tenantSlug = `idem-retention-none-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Idempotency Retention No Delete Tenant'
  });
  const tenantId = session.tenant.id;
  const db = session.pool;
  if (db) openPools.add(db);

  const keepKey = `idem-ret-keep-${randomUUID()}`;
  await db.query(
    `INSERT INTO idempotency_keys (
        tenant_id,
        key,
        endpoint,
        request_hash,
        response_status,
        response_body,
        status,
        response_ref,
        updated_at,
        created_at
      ) VALUES ($1, $2, 'receipts.post', $3, 200, '{"ok":true}'::jsonb, 'SUCCEEDED', NULL, now(), now())`,
    [tenantId, keepKey, hashForKey('keep', keepKey)]
  );

  const pruneResult = await withRetentionSettings(36500, 5000, async () => pruneIdempotencyKeys());
  assert.equal(pruneResult.deleted, 0, `expected no deletions with very large retention window`);

  const stillExists = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM idempotency_keys
      WHERE tenant_id = $1
        AND key = $2`,
    [tenantId, keepKey]
  );
  assert.equal(Number(stillExists.rows[0]?.count ?? 0), 1);
});
