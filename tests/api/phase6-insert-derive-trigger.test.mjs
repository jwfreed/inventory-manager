import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSession } from './helpers/ensureSession.mjs';

let db;

test.before(async () => {
  const session = await ensureSession();
  db = session.pool;
});

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
  const slug = `phase6-derive-${label}-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
     VALUES ($1, $2, $3, NULL, now())`,
    [tenantId, `Phase6 Derive ${label}`, slug]
  );
  return tenantId;
}

async function cleanupTenant(tenantId) {
  await db.query(`DELETE FROM locations WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
}

async function insertWarehouseRootRaw(client, tenantId, id) {
  const code = `WH-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO locations (
      id, tenant_id, code, name, type, active, created_at, updated_at,
      role, is_sellable, parent_location_id, warehouse_id
    ) VALUES ($1, $2, $3, $4, 'warehouse', true, now(), now(), NULL, false, NULL, $1)`,
    [id, tenantId, code, `Warehouse ${code}`]
  );
}

async function insertWarehouseRootNoWarehouseId(client, tenantId, id) {
  const code = `WH-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO locations (
      id, tenant_id, code, name, type, active, created_at, updated_at,
      role, is_sellable, parent_location_id, warehouse_id
    ) VALUES ($1, $2, $3, $4, 'warehouse', true, now(), now(), 'SELLABLE', true, NULL, NULL)`,
    [id, tenantId, code, `Warehouse ${code}`]
  );
}

async function insertNodeNoWarehouseId(client, {
  tenantId,
  id,
  parentId,
  type = 'bin'
}) {
  const code = `NODE-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO locations (
      id, tenant_id, code, name, type, active, created_at, updated_at,
      role, is_sellable, parent_location_id, warehouse_id
    ) VALUES ($1, $2, $3, $4, $5, true, now(), now(), 'SELLABLE', true, $6, NULL)`,
    [id, tenantId, code, `Node ${code}`, type, parentId]
  );
}

async function insertNodeWithWarehouseId(client, {
  tenantId,
  id,
  parentId,
  warehouseId,
  type = 'bin'
}) {
  const code = `NODE-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO locations (
      id, tenant_id, code, name, type, active, created_at, updated_at,
      role, is_sellable, parent_location_id, warehouse_id
    ) VALUES ($1, $2, $3, $4, $5, true, now(), now(), 'SELLABLE', true, $6, $7)`,
    [id, tenantId, code, `Node ${code}`, type, parentId, warehouseId]
  );
}

async function fetchWarehouseId(client, tenantId, id) {
  const res = await client.query(
    `SELECT warehouse_id FROM locations WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  return res.rows[0]?.warehouse_id ?? null;
}

test('insert warehouse root auto-sets warehouse_id = id', async () => {
  let tenantId;
  try {
    await withTx(async (client) => {
      tenantId = await insertTenant(client, 'root');
      const warehouseId = randomUUID();
      await insertWarehouseRootNoWarehouseId(client, tenantId, warehouseId);
      const whId = await fetchWarehouseId(client, tenantId, warehouseId);
      assert.equal(whId, warehouseId);
    });
  } finally {
    if (tenantId) await cleanupTenant(tenantId);
  }
});

test('insert child inherits parent warehouse_id', async () => {
  let tenantId;
  try {
    await withTx(async (client) => {
      tenantId = await insertTenant(client, 'inherit');
      const w1 = randomUUID();
      await insertWarehouseRootRaw(client, tenantId, w1);
      const parentId = randomUUID();
      await insertNodeWithWarehouseId(client, {
        tenantId,
        id: parentId,
        parentId: w1,
        warehouseId: w1
      });

      const childId = randomUUID();
      await insertNodeNoWarehouseId(client, {
        tenantId,
        id: childId,
        parentId
      });
      const whId = await fetchWarehouseId(client, tenantId, childId);
      assert.equal(whId, w1);
    });
  } finally {
    if (tenantId) await cleanupTenant(tenantId);
  }
});

test('insert child with missing parent raises PARENT_WAREHOUSE_ID_MISSING', async () => {
  let tenantId;
  try {
    await withTx(async (client) => {
      tenantId = await insertTenant(client, 'missing-parent');
      await expectErrorWithSavepoint(client, 'PARENT_WAREHOUSE_ID_MISSING', async () => {
        const childId = randomUUID();
        await insertNodeNoWarehouseId(client, {
          tenantId,
          id: childId,
          parentId: randomUUID()
        });
      });
    });
  } finally {
    if (tenantId) await cleanupTenant(tenantId);
  }
});

test('insert child under parent from different tenant raises PARENT_WAREHOUSE_ID_MISSING', async () => {
  let tenantA;
  let tenantB;
  try {
    await withTx(async (client) => {
      tenantA = await insertTenant(client, 'tenant-a');
      tenantB = await insertTenant(client, 'tenant-b');
      const w1 = randomUUID();
      await insertWarehouseRootRaw(client, tenantA, w1);
      const parentId = randomUUID();
      await insertNodeWithWarehouseId(client, {
        tenantId: tenantA,
        id: parentId,
        parentId: w1,
        warehouseId: w1
      });

      await expectErrorWithSavepoint(client, 'PARENT_WAREHOUSE_ID_MISSING', async () => {
        const childId = randomUUID();
        await insertNodeNoWarehouseId(client, {
          tenantId: tenantB,
          id: childId,
          parentId
        });
      });
    });
  } finally {
    if (tenantA) await cleanupTenant(tenantA);
    if (tenantB) await cleanupTenant(tenantB);
  }
});

test('insert child overrides incorrect warehouse_id', async () => {
  let tenantId;
  try {
    await withTx(async (client) => {
      tenantId = await insertTenant(client, 'override');
      const w1 = randomUUID();
      const w2 = randomUUID();
      await insertWarehouseRootRaw(client, tenantId, w1);
      await insertWarehouseRootRaw(client, tenantId, w2);
      const parentId = randomUUID();
      await insertNodeWithWarehouseId(client, {
        tenantId,
        id: parentId,
        parentId: w1,
        warehouseId: w1
      });

      const childId = randomUUID();
      await insertNodeWithWarehouseId(client, {
        tenantId,
        id: childId,
        parentId,
        warehouseId: w2
      });
      const whId = await fetchWarehouseId(client, tenantId, childId);
      assert.equal(whId, w1);
    });
  } finally {
    if (tenantId) await cleanupTenant(tenantId);
  }
});
