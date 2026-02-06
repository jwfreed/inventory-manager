import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool, Client } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function withTx(fn) {
  const client = await pool.connect();
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

async function createTenant(client, label) {
  const tenantId = randomUUID();
  const slug = `phase6-${label}-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
     VALUES ($1, $2, $3, NULL, now())`,
    [tenantId, `Phase6 ${label}`, slug]
  );
  return tenantId;
}

async function cleanupTenant(tenantId) {
  await pool.query(`DELETE FROM locations WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
}

async function createWarehouseRoot(client, tenantId, label) {
  const id = randomUUID();
  const code = `WH-${label}-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO locations (
      id, tenant_id, code, name, type, active, created_at, updated_at,
      role, is_sellable, parent_location_id, warehouse_id
    ) VALUES ($1, $2, $3, $4, 'warehouse', true, now(), now(), 'SELLABLE', true, NULL, $1)`,
    [id, tenantId, code, `Warehouse ${label}`]
  );
  return { id, code };
}

async function createLocation(client, {
  tenantId,
  parentLocationId,
  warehouseId,
  label,
  role = 'SELLABLE',
  isSellable = true,
  type = 'bin'
}) {
  const id = randomUUID();
  const code = `${label}-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO locations (
      id, tenant_id, code, name, type, active, created_at, updated_at,
      role, is_sellable, parent_location_id, warehouse_id
    ) VALUES ($1, $2, $3, $4, $5, true, now(), now(), $6, $7, $8, $9)`,
    [id, tenantId, code, label, type, role, isSellable, parentLocationId, warehouseId]
  );
  return id;
}

async function createDescendants(client, {
  tenantId,
  parentId,
  warehouseId,
  count,
  label
}) {
  await client.query(
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

async function fetchDescendants(client, tenantId, rootId) {
  const res = await client.query(
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

function assertWarehouseIds(rows, expectedId, diag) {
  const bad = rows.filter((row) => row.warehouse_id !== expectedId);
  if (bad.length > 0) {
    throw new Error(`WAREHOUSE_ID_MISMATCH\n${safeJson({ ...diag, bad })}`);
  }
}

test('cascade function updates a small subtree and leaves root unchanged', async () => {
  let tenantId;
  try {
    await withTx(async (client) => {
      tenantId = await createTenant(client, 'small');
      const w1 = await createWarehouseRoot(client, tenantId, 'A');
      const w2 = await createWarehouseRoot(client, tenantId, 'B');
      const parentId = await createLocation(client, {
        tenantId,
        parentLocationId: w1.id,
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

      await client.query(`SELECT cascade_warehouse_id_to_descendants($1, $2, $3)`, [
        tenantId,
        parentId,
        w2.id
      ]);

      const parentRow = await client.query(
        `SELECT warehouse_id FROM locations WHERE id = $1 AND tenant_id = $2`,
        [parentId, tenantId]
      );
      assert.equal(parentRow.rows[0]?.warehouse_id, w1.id);

      const descendants = await fetchDescendants(client, tenantId, parentId);
      assert.equal(descendants.length, 10);
      assertWarehouseIds(descendants, w2.id, {
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

test('cascade function aborts on >1000 descendants', async () => {
  let tenantId;
  try {
    await withTx(async (client) => {
      tenantId = await createTenant(client, 'big');
      const w1 = await createWarehouseRoot(client, tenantId, 'A');
      const w2 = await createWarehouseRoot(client, tenantId, 'B');
      const parentId = await createLocation(client, {
        tenantId,
        parentLocationId: w1.id,
        warehouseId: w1.id,
        label: 'P-BIG'
      });
      await createDescendants(client, {
        tenantId,
        parentId,
        warehouseId: w1.id,
        count: 1001,
        label: 'D-BIG'
      });

      await client.query('SAVEPOINT sp');
      let caught;
      try {
        await client.query(`SELECT cascade_warehouse_id_to_descendants($1, $2, $3)`, [
          tenantId,
          parentId,
          w2.id
        ]);
      } catch (err) {
        caught = err;
      }
      await client.query('ROLLBACK TO SAVEPOINT sp');
      await client.query('RELEASE SAVEPOINT sp');
      assert.ok(caught, 'Expected CASCADE_SIZE_EXCEEDED');
      assert.ok(String(caught.message || '').includes('CASCADE_SIZE_EXCEEDED'));
      assert.ok(String(caught.detail || '').includes('descendant_count=1001'));

      const descendants = await fetchDescendants(client, tenantId, parentId);
      assert.equal(descendants.length, 1001);
      assertWarehouseIds(descendants, w1.id, {
        tenantId,
        w1: w1.id,
        w2: w2.id,
        parentId,
        count: descendants.length,
        error: { message: caught.message, detail: caught.detail }
      });
    });
  } finally {
    if (tenantId) await cleanupTenant(tenantId);
  }
});

test('cascade function aborts on lock conflict with no partial updates', async () => {
  let tenantId;
  try {
    tenantId = randomUUID();
    const slug = `phase6-lock-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
       VALUES ($1, $2, $3, NULL, now())`,
      [tenantId, `Phase6 lock`, slug]
    );
    const w1 = await createWarehouseRoot(pool, tenantId, 'A');
    const w2 = await createWarehouseRoot(pool, tenantId, 'B');
    const parentId = await createLocation(pool, {
      tenantId,
      parentLocationId: w1.id,
      warehouseId: w1.id,
      label: 'P-LOCK'
    });
    await createDescendants(pool, {
      tenantId,
      parentId,
      warehouseId: w1.id,
      count: 10,
      label: 'D-LOCK'
    });

    const baseDescendants = await fetchDescendants(pool, tenantId, parentId);
    const lockedId = baseDescendants[0]?.id;
    assert.ok(lockedId);

    const lockClient = new Client({ connectionString: process.env.DATABASE_URL });
    await lockClient.connect();
    try {
      await lockClient.query('BEGIN');
      await lockClient.query(
        `SELECT 1 FROM locations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [lockedId, tenantId]
      );

      await withTx(async (client) => {
        await client.query('SAVEPOINT sp');
        let caught;
        try {
          await client.query(`SELECT cascade_warehouse_id_to_descendants($1, $2, $3)`, [
            tenantId,
            parentId,
            w2.id
          ]);
        } catch (err) {
          caught = err;
        }
        await client.query('ROLLBACK TO SAVEPOINT sp');
        await client.query('RELEASE SAVEPOINT sp');
        assert.ok(caught, 'Expected CASCADE_LOCK_CONFLICT');
        assert.ok(String(caught.message || '').includes('CASCADE_LOCK_CONFLICT'));

        const descendantsAfter = await fetchDescendants(client, tenantId, parentId);
        assertWarehouseIds(descendantsAfter, w1.id, {
          tenantId,
          w1: w1.id,
          w2: w2.id,
          parentId,
          lockedId,
          count: descendantsAfter.length,
          error: { message: caught.message }
        });
      });
    } finally {
      await lockClient.query('ROLLBACK');
      await lockClient.end();
    }
  } finally {
    if (tenantId) await cleanupTenant(tenantId);
  }
});
