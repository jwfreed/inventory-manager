import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { ensureSession } from './helpers/ensureSession.mjs';

let db;

test.before(async () => {
  const session = await ensureSession();
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

async function insertTenant(db, label) {
  const tenantId = randomUUID();
  const slug = `phase6-${label}-${randomUUID().slice(0, 8)}`;
  await db.query(
    `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
     VALUES ($1, $2, $3, NULL, now())`,
    [tenantId, `Phase6 ${label}`, slug]
  );
  return tenantId;
}

async function cleanupTenant(tenantId) {
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
    `WITH RECURSIVE descendants AS (
       SELECT id, parent_location_id, tenant_id, warehouse_id, 1 AS depth
         FROM locations
        WHERE tenant_id = $1 AND parent_location_id = $2
       UNION ALL
       SELECT l.id, l.parent_location_id, l.tenant_id, l.warehouse_id, d.depth + 1
         FROM locations l
         JOIN descendants d
           ON l.parent_location_id = d.id
          AND l.tenant_id = d.tenant_id
        WHERE d.depth < 1000
     )
     SELECT id, warehouse_id FROM descendants`,
    [tenantId, rootId]
  );
  return res.rows;
}

async function fetchWarehouseId(db, tenantId, id) {
  const res = await db.query(
    `SELECT warehouse_id FROM locations WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  return res.rows[0]?.warehouse_id ?? null;
}

function assertAllWarehouseId(rows, expectedId, diag) {
  const bad = rows.filter((row) => row.warehouse_id !== expectedId);
  if (bad.length > 0) {
    throw new Error(`WAREHOUSE_ID_MISMATCH\n${safeJson({ ...diag, bad })}`);
  }
}

test('trigger no-ops when parent does not change', async () => {
  let tenantId;
  try {
    await withTx(async (client) => {
      tenantId = await insertTenant(client, 'noop');
      const w1 = await insertWarehouseRoot(client, tenantId, 'A');
      const w2 = await insertWarehouseRoot(client, tenantId, 'B');
      const parentId = await insertNode(client, {
        tenantId,
        parentId: w1.id,
        warehouseId: w1.id,
        label: 'P'
      });
      await createDescendants(client, {
        tenantId,
        parentId,
        warehouseId: w1.id,
        count: 10,
        label: 'D'
      });

      await client.query(
        `UPDATE locations SET code = code WHERE tenant_id = $1 AND id = $2`,
        [tenantId, parentId]
      );

      const parentWarehouseId = await fetchWarehouseId(client, tenantId, parentId);
      assert.equal(parentWarehouseId, w1.id);
      const descendants = await fetchDescendants(client, tenantId, parentId);
      assertAllWarehouseId(descendants, w1.id, {
        tenantId,
        w1: w1.id,
        w2: w2.id,
        parentId,
        count: descendants.length
      });
    });
  } finally {
    if (tenantId) await cleanupTenant(tenantId);
  }
});

test('reparent within same warehouse does not cascade', async () => {
  let tenantId;
  try {
    await withTx(async (client) => {
      tenantId = await insertTenant(client, 'same-wh');
      const w1 = await insertWarehouseRoot(client, tenantId, 'A');
      const parentA = await insertNode(client, {
        tenantId,
        parentId: w1.id,
        warehouseId: w1.id,
        label: 'A'
      });
      const parentB = await insertNode(client, {
        tenantId,
        parentId: w1.id,
        warehouseId: w1.id,
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

      const rootWarehouseId = await fetchWarehouseId(client, tenantId, rootId);
      assert.equal(rootWarehouseId, w1.id);
      const descendants = await fetchDescendants(client, tenantId, rootId);
      assertAllWarehouseId(descendants, w1.id, {
        tenantId,
        w1: w1.id,
        rootId,
        count: descendants.length
      });
    });
  } finally {
    if (tenantId) await cleanupTenant(tenantId);
  }
});

test('reparent across warehouses updates node and descendants', async () => {
  let tenantId;
  try {
    await withTx(async (client) => {
      tenantId = await insertTenant(client, 'cross-wh');
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

      const rootWarehouseId = await fetchWarehouseId(client, tenantId, rootId);
      assert.equal(rootWarehouseId, w2.id);
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

test('oversize subtree fails atomically with CASCADE_SIZE_EXCEEDED', async () => {
  let tenantId;
  try {
    await withTx(async (client) => {
      tenantId = await insertTenant(client, 'oversize');
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
        count: 1001,
        label: 'D'
      });

      await expectErrorWithSavepoint(client, 'CASCADE_SIZE_EXCEEDED', async () => {
        await client.query(
          `UPDATE locations
              SET parent_location_id = $1
            WHERE tenant_id = $2 AND id = $3`,
          [parentB, tenantId, rootId]
        );
      });

      const rootWarehouseId = await fetchWarehouseId(client, tenantId, rootId);
      assert.equal(rootWarehouseId, w1.id);
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

test('lock conflict fails atomically with CASCADE_LOCK_CONFLICT', async () => {
  let tenantId;
  let lockClient;
  try {
    tenantId = await insertTenant(db, 'lock');
    const w1 = await insertWarehouseRoot(db, tenantId, 'A');
    const w2 = await insertWarehouseRoot(db, tenantId, 'B');
    const parentA = await insertNode(db, {
      tenantId,
      parentId: w1.id,
      warehouseId: w1.id,
      label: 'A'
    });
    const parentB = await insertNode(db, {
      tenantId,
      parentId: w2.id,
      warehouseId: w2.id,
      label: 'B'
    });
    const rootId = await insertNode(db, {
      tenantId,
      parentId: parentA,
      warehouseId: w1.id,
      label: 'P'
    });
    await createDescendants(db, {
      tenantId,
      parentId: rootId,
      warehouseId: w1.id,
      count: 10,
      label: 'D'
    });

    const baseDescendants = await fetchDescendants(db, tenantId, rootId);
    const lockedId = baseDescendants[0]?.id;
    assert.ok(lockedId);

    lockClient = new Client({ connectionString: process.env.DATABASE_URL });
    await lockClient.connect();
    await lockClient.query('BEGIN');
    await lockClient.query(
      `SELECT 1 FROM locations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, lockedId]
    );

    await withTx(async (client) => {
      await expectErrorWithSavepoint(client, 'CASCADE_LOCK_CONFLICT', async () => {
        await client.query(
          `UPDATE locations
              SET parent_location_id = $1
            WHERE tenant_id = $2 AND id = $3`,
          [parentB, tenantId, rootId]
        );
      });

      const rootWarehouseId = await fetchWarehouseId(client, tenantId, rootId);
      assert.equal(rootWarehouseId, w1.id);
      const descendants = await fetchDescendants(client, tenantId, rootId);
      assertAllWarehouseId(descendants, w1.id, {
        tenantId,
        w1: w1.id,
        w2: w2.id,
        rootId,
        lockedId,
        count: descendants.length
      });
    });
  } finally {
    if (lockClient) {
      await lockClient.query('ROLLBACK');
      await lockClient.end();
    }
    if (tenantId) await cleanupTenant(tenantId);
  }
});
