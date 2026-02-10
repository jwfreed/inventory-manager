import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';

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

async function insertTenant(client, label) {
  const tenantId = randomUUID();
  const slug = `phase6-validate-${label}-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
     VALUES ($1, $2, $3, NULL, now())`,
    [tenantId, `Phase6 Validate ${label}`, slug]
  );
  return tenantId;
}

async function cleanupTenant(tenantId) {
  await db.query(`DELETE FROM warehouse_default_location WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM locations WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
}

async function insertWarehouseRoot(db, tenantId, label) {
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

async function insertNode(db, {
  tenantId,
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

async function createDescendants(db, {
  tenantId,
  parentId,
  warehouseId,
  count,
  label
}) {
  await db.query(
    `INSERT INTO locations (
      id, tenant_id, code, name, type, active, created_at, updated_at,
      role, is_sellable, parent_location_id, warehouse_id
    )
    SELECT gen_random_uuid(),
           $1,
           $2 || '-' || gs::text || '-' || substr(md5(random()::text), 1, 6),
           $3 || ' ' || gs::text,
           'bin',
           true,
           now(),
           now(),
           'SELLABLE',
           true,
           $4,
           $5
      FROM generate_series(1, $6) gs`,
    [tenantId, label, label, parentId, warehouseId, count]
  );
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

async function fetchWarehouseId(db, tenantId, id) {
  const res = await db.query(
    `SELECT warehouse_id, parent_location_id FROM locations WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  return res.rows[0] ?? null;
}

async function setDefault(db, { tenantId, warehouseId, role, locationId }) {
  await db.query(
    `DELETE FROM warehouse_default_location
      WHERE tenant_id = $1 AND warehouse_id = $2 AND role = $3`,
    [tenantId, warehouseId, role]
  );
  await db.query(
    `INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, warehouseId, role, locationId]
  );
}

function assertAllWarehouseId(rows, expectedId, diag) {
  const bad = rows.filter((row) => row.warehouse_id !== expectedId);
  if (bad.length > 0) {
    throw new Error(`WAREHOUSE_ID_MISMATCH\n${safeJson({ ...diag, bad })}`);
  }
}

test('blocks cross-warehouse move when defaults exist in subtree', async () => {
  let tenantId;
  try {
    await withTx(async (client) => {
      tenantId = await insertTenant(client, 'block-default');
      const w1 = await insertWarehouseRoot(client, tenantId, 'A');
      const w2 = await insertWarehouseRoot(client, tenantId, 'B');
      const parentA = await insertNode(client, {
        tenantId,
        parentId: w1.id,
        warehouseId: w1.id,
        label: 'A'
      });
      const parentB = await insertNode(client, {
        tenantId,
        parentId: w2.id,
        warehouseId: w2.id,
        label: 'B'
      });
      const rootId = await insertNode(client, {
        tenantId,
        parentId: parentA,
        warehouseId: w1.id,
        label: 'P'
      });
      const sellableId = await insertNode(client, {
        tenantId,
        parentId: rootId,
        warehouseId: w1.id,
        label: 'S'
      });
      await setDefault(client, {
        tenantId,
        warehouseId: w1.id,
        role: 'SELLABLE',
        locationId: sellableId
      });

      await expectErrorWithSavepoint(client, 'PARENT_MOVE_BREAKS_DEFAULT_LOCATION', async () => {
        await client.query(
          `UPDATE locations
              SET parent_location_id = $1
            WHERE tenant_id = $2 AND id = $3`,
          [parentB, tenantId, rootId]
        );
      });

      const rootRow = await fetchWarehouseId(client, tenantId, rootId);
      assert.equal(rootRow?.warehouse_id, w1.id);
      assert.equal(rootRow?.parent_location_id, parentA);
      const descendants = await fetchDescendants(client, tenantId, rootId);
      assertAllWarehouseId(descendants, w1.id, {
        tenantId,
        w1: w1.id,
        w2: w2.id,
        rootId,
        count: descendants.length
      });
    });
  } finally {
    if (tenantId) await cleanupTenant(tenantId);
  }
});

test('allows cross-warehouse move when no defaults in subtree', async () => {
  let tenantId;
  try {
    await withTx(async (client) => {
      tenantId = await insertTenant(client, 'allow-no-default');
      const w1 = await insertWarehouseRoot(client, tenantId, 'A');
      const w2 = await insertWarehouseRoot(client, tenantId, 'B');
      const parentA = await insertNode(client, {
        tenantId,
        parentId: w1.id,
        warehouseId: w1.id,
        label: 'A'
      });
      const parentB = await insertNode(client, {
        tenantId,
        parentId: w2.id,
        warehouseId: w2.id,
        label: 'B'
      });
      const rootId = await insertNode(client, {
        tenantId,
        parentId: parentA,
        warehouseId: w1.id,
        label: 'P'
      });
      await createDescendants(client, {
        tenantId,
        parentId: rootId,
        warehouseId: w1.id,
        count: 10,
        label: 'D'
      });

      await client.query(
        `UPDATE locations
            SET parent_location_id = $1
          WHERE tenant_id = $2 AND id = $3`,
        [parentB, tenantId, rootId]
      );

      const rootRow = await fetchWarehouseId(client, tenantId, rootId);
      assert.equal(rootRow?.warehouse_id, w2.id);
      assert.equal(rootRow?.parent_location_id, parentB);
      const descendants = await fetchDescendants(client, tenantId, rootId);
      assertAllWarehouseId(descendants, w2.id, {
        tenantId,
        w1: w1.id,
        w2: w2.id,
        rootId,
        count: descendants.length
      });
    });
  } finally {
    if (tenantId) await cleanupTenant(tenantId);
  }
});

test('blocks move when default points to deep descendant', async () => {
  let tenantId;
  try {
    await withTx(async (client) => {
      tenantId = await insertTenant(client, 'block-deep');
      const w1 = await insertWarehouseRoot(client, tenantId, 'A');
      const w2 = await insertWarehouseRoot(client, tenantId, 'B');
      const parentA = await insertNode(client, {
        tenantId,
        parentId: w1.id,
        warehouseId: w1.id,
        label: 'A'
      });
      const parentB = await insertNode(client, {
        tenantId,
        parentId: w2.id,
        warehouseId: w2.id,
        label: 'B'
      });
      const rootId = await insertNode(client, {
        tenantId,
        parentId: parentA,
        warehouseId: w1.id,
        label: 'P'
      });
      const xId = await insertNode(client, {
        tenantId,
        parentId: rootId,
        warehouseId: w1.id,
        label: 'X'
      });
      const yId = await insertNode(client, {
        tenantId,
        parentId: xId,
        warehouseId: w1.id,
        label: 'Y'
      });
      const sId = await insertNode(client, {
        tenantId,
        parentId: yId,
        warehouseId: w1.id,
        label: 'S'
      });
      await setDefault(client, {
        tenantId,
        warehouseId: w1.id,
        role: 'SELLABLE',
        locationId: sId
      });

      await expectErrorWithSavepoint(client, 'PARENT_MOVE_BREAKS_DEFAULT_LOCATION', async () => {
        await client.query(
          `UPDATE locations
              SET parent_location_id = $1
            WHERE tenant_id = $2 AND id = $3`,
          [parentB, tenantId, rootId]
        );
      });

      const rootRow = await fetchWarehouseId(client, tenantId, rootId);
      assert.equal(rootRow?.warehouse_id, w1.id);
      assert.equal(rootRow?.parent_location_id, parentA);
      const descendants = await fetchDescendants(client, tenantId, rootId);
      assertAllWarehouseId(descendants, w1.id, {
        tenantId,
        w1: w1.id,
        w2: w2.id,
        rootId,
        count: descendants.length
      });
    });
  } finally {
    if (tenantId) await cleanupTenant(tenantId);
  }
});
