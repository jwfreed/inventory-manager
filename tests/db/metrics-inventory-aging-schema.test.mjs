import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Pool } from 'pg';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { MetricsService } = require('../../src/services/metrics.service.ts');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const tenantIds = [];

test('inventory aging query remains compatible with live lots schema', async () => {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);

  await pool.query(
    `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
     VALUES ($1, $2, $3, NULL, now())`,
    [tenantId, 'Metrics Aging Schema Guard', `metrics-aging-${tenantId.slice(0, 8)}`]
  );

  const rows = await MetricsService.getInventoryAging(tenantId);

  assert.deepEqual(rows, []);
});

test.after(async () => {
  if (tenantIds.length > 0) {
    await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
  }
  await pool.end();
});
