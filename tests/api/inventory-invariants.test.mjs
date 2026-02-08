import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { ensureSession } from './helpers/ensureSession.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { runInventoryInvariantCheck } = require('../../src/jobs/inventoryInvariants.job.ts');

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

async function getSession() {
  const session = await ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: 'Invariant Tenant'
  });
  db = session.pool;
  return session;
}

test('invariants job separates legacy source_type gaps', async () => {
  const session = await getSession();
  const tenantId = session.tenant?.id;
  assert.ok(tenantId);

  await db.query(
    `INSERT INTO inventory_movements (
        id, tenant_id, movement_type, status, occurred_at, created_at, updated_at
     ) VALUES ($1, $2, 'receive', 'posted', now(), now(), now())`,
    [randomUUID(), tenantId]
  );

  const results = await runInventoryInvariantCheck({ tenantIds: [tenantId] });
  const summary = results.find((row) => row.tenantId === tenantId);
  assert.ok(summary);
  assert.equal(summary.receiptLineCount, 0);
  assert.equal(summary.receiptMovementLineCount, 0);
  assert.equal(summary.receiptLegacyMovementCount, 1);
});
