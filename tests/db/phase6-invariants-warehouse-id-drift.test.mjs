import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { expectInvariantLog } from '../helpers/invariantLogs.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { runInventoryInvariantCheck } = require('../../src/jobs/inventoryInvariants.job.ts');

let db;

test.before(async () => {
  const session = await ensureDbSession();
  db = session.pool;
});

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function withTx(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function expectErrorWithSavepoint(client, expectedSubstring, fn) {
  await client.query('SAVEPOINT sp');
  try {
    await fn();
    assert.fail(`Expected error including ${expectedSubstring}`);
  } catch (err) {
    const msg = String(err?.message || err);
    assert.ok(msg.includes(expectedSubstring), `Expected "${expectedSubstring}" in error: ${msg}`);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT sp');
    await client.query('RELEASE SAVEPOINT sp');
  }
}

async function insertTenant(label) {
  const tenantId = randomUUID();
  const slug = `phase6-drift-${label}-${randomUUID().slice(0, 8)}`;
  await db.query(
    `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
     VALUES ($1, $2, $3, NULL, now())`,
    [tenantId, `Phase6 Drift ${label}`, slug]
  );
  return tenantId;
}

async function cleanupTenant(tenantId) {
  await db.query(`DELETE FROM inventory_invariant_blocks WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM locations WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
}

async function insertWarehouseRoot(tenantId, label) {
  const id = randomUUID();
  const code = `WH-${label}-${randomUUID().slice(0, 8)}`;
  await db.query(
    `INSERT INTO locations (
      id, tenant_id, code, name, type, active, created_at, updated_at,
      role, is_sellable, parent_location_id, warehouse_id
    ) VALUES ($1, $2, $3, $4, 'warehouse', true, now(), now(), NULL, false, NULL, $1)`,
    [id, tenantId, code, `Warehouse ${label}`]
  );
  return { id, code };
}

async function insertNode(tenantId, {
  parentId,
  warehouseId,
  label,
  type = 'bin'
}) {
  const id = randomUUID();
  const code = `${label}-${randomUUID().slice(0, 8)}`;
  await db.query(
    `INSERT INTO locations (
      id, tenant_id, code, name, type, active, created_at, updated_at,
      role, is_sellable, parent_location_id, warehouse_id
    ) VALUES ($1, $2, $3, $4, $5, true, now(), now(), 'SELLABLE', true, $6, $7)`,
    [id, tenantId, code, label, type, parentId, warehouseId]
  );
  return id;
}

async function fetchDescendants(db, tenantId, rootId) {
  const res = await db.query(
    `WITH RECURSIVE subtree AS (
       SELECT id, parent_location_id, tenant_id, warehouse_id, 1 AS depth
         FROM locations
        WHERE tenant_id = $1 AND id = $2
       UNION ALL
       SELECT l.id, l.parent_location_id, l.tenant_id, l.warehouse_id, s.depth + 1
         FROM locations l
         JOIN subtree s
           ON l.parent_location_id = s.id
          AND l.tenant_id = s.tenant_id
        WHERE s.depth < 1000
     )
     SELECT id, warehouse_id FROM subtree WHERE id <> $2`,
    [tenantId, rootId]
  );
  return res.rows;
}

async function fetchBlock(tenantId) {
  const res = await db.query(
    `SELECT tenant_id, code, active, details
       FROM inventory_invariant_blocks
      WHERE tenant_id = $1 AND code = 'WAREHOUSE_ID_DRIFT'`,
    [tenantId]
  );
  return res.rows[0] ?? null;
}

test('WAREHOUSE_ID_DRIFT is detected and blocks reparent until cleared', async () => {
  let tenantId;
  try {
    tenantId = await insertTenant('detect');
    const w1 = await insertWarehouseRoot(tenantId, 'A');
    const w2 = await insertWarehouseRoot(tenantId, 'B');
    const parentA = await insertNode(tenantId, {
      parentId: w1.id,
      warehouseId: w1.id,
      label: 'A'
    });
    const parentB = await insertNode(tenantId, {
      parentId: w2.id,
      warehouseId: w2.id,
      label: 'B'
    });
    const rootId = await insertNode(tenantId, {
      parentId: parentA,
      warehouseId: w1.id,
      label: 'P'
    });
    const childId = await insertNode(tenantId, {
      parentId: rootId,
      warehouseId: w1.id,
      label: 'C'
    });

    await db.query(
      `UPDATE locations SET warehouse_id = $1 WHERE tenant_id = $2 AND id = $3`,
      [w2.id, tenantId, childId]
    );

    expectInvariantLog(/CRITICAL invariant violation/);
    const results = await runInventoryInvariantCheck({ tenantIds: [tenantId] });
    const summary = results.find((row) => row.tenantId === tenantId);
    assert.ok(summary?.warehouseIdDriftCount && summary.warehouseIdDriftCount > 0);

    const block = await fetchBlock(tenantId);
    assert.ok(block?.active, `Expected active block: ${safeJson(block)}`);

    await withTx(async (client) => {
      await expectErrorWithSavepoint(client, 'WAREHOUSE_ID_DRIFT_REPARENT_BLOCKED', async () => {
        await client.query(
          `UPDATE locations
              SET parent_location_id = $1
            WHERE tenant_id = $2 AND id = $3`,
          [parentB, tenantId, rootId]
        );
      });
      const row = await client.query(
        `SELECT parent_location_id FROM locations WHERE tenant_id = $1 AND id = $2`,
        [tenantId, rootId]
      );
      assert.equal(row.rows[0]?.parent_location_id, parentA);
    });

    await db.query(
      `UPDATE locations SET warehouse_id = $1 WHERE tenant_id = $2 AND id = $3`,
      [w1.id, tenantId, childId]
    );
    await runInventoryInvariantCheck({ tenantIds: [tenantId] });
    const cleared = await fetchBlock(tenantId);
    assert.ok(cleared && cleared.active === false, `Expected block cleared: ${safeJson(cleared)}`);

    await withTx(async (client) => {
      await client.query(
        `UPDATE locations
            SET parent_location_id = $1
          WHERE tenant_id = $2 AND id = $3`,
        [parentB, tenantId, rootId]
      );
      const descendants = await fetchDescendants(client, tenantId, rootId);
      const bad = descendants.filter((row) => row.warehouse_id !== w2.id);
      assert.equal(bad.length, 0, safeJson({ bad, descendants }));
    });
  } finally {
    if (tenantId) await cleanupTenant(tenantId);
  }
});
