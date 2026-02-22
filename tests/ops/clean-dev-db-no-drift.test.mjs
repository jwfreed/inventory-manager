import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { seedWarehouseTopologyForTenant } from '../../scripts/seed_warehouse_topology.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { runInventoryInvariantCheck } = require('../../src/jobs/inventoryInvariants.job.ts');
const { ensureWarehouseDefaults } = require('../../src/services/warehouseDefaults.service.ts');

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';

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

async function ensureCleanTenantSession() {
  return ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: `clean-dev-${randomUUID().slice(0, 8)}`,
    tenantName: 'Clean Dev Drift Guard'
  });
}

async function seedTopology(pool, tenantId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await seedWarehouseTopologyForTenant(client, tenantId, { fix: true });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('clean seeded tenant has zero invariant drift and no legacy movement source gaps', async () => {
  const session = await ensureCleanTenantSession();
  const tenantId = session.tenant?.id;
  assert.ok(tenantId, 'tenantId is required');

  await seedTopology(session.pool, tenantId);
  await ensureWarehouseDefaults(tenantId, { repair: false });

  const summaries = await runInventoryInvariantCheck({
    tenantIds: [tenantId],
    strict: true
  });
  const summary = summaries.find((row) => row.tenantId === tenantId);
  assert.ok(summary, 'expected tenant summary');
  assert.equal(summary.receiptLegacyMovementCount, 0);
  assert.equal(summary.qcLegacyMovementCount, 0);
  assert.equal(summary.nonSellableFlowScopeInvalidCount, 0);
  assert.equal(summary.salesOrderWarehouseScopeMismatchCount, 0);
  assert.equal(summary.warehouseIdDriftCount, 0);

  const nullReceiveSources = await session.pool.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND movement_type = 'receive'
        AND source_type IS NULL`,
    [tenantId]
  );
  assert.equal(Number(nullReceiveSources.rows[0]?.count ?? 0), 0);
});
