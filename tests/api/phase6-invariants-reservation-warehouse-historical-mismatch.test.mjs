import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { runInventoryInvariantCheck } = require('../../src/jobs/inventoryInvariants.job.ts');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function insertTenant(client, label) {
  const tenantId = randomUUID();
  const slug = `phase6-res-hist-${label}-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
     VALUES ($1, $2, $3, NULL, now())`,
    [tenantId, `Phase6 Res Hist ${label}`, slug]
  );
  return tenantId;
}

async function insertWarehouseRoot(client, tenantId, label) {
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

async function insertNode(client, tenantId, {
  parentId,
  warehouseId,
  label,
  type = 'bin'
}) {
  const id = randomUUID();
  const code = `${label}-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO locations (
      id, tenant_id, code, name, type, active, created_at, updated_at,
      role, is_sellable, parent_location_id, warehouse_id
    ) VALUES ($1, $2, $3, $4, $5, true, now(), now(), 'SELLABLE', true, $6, $7)`,
    [id, tenantId, code, label, type, parentId, warehouseId]
  );
  return id;
}

async function insertItem(client, tenantId, label) {
  const id = randomUUID();
  const sku = `SKU-${label}-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO items (id, tenant_id, sku, name, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, now(), now())`,
    [id, tenantId, sku, `Item ${label}`]
  );
  return id;
}

async function insertReservation(client, {
  tenantId,
  itemId,
  locationId,
  warehouseId,
  status = 'RESERVED'
}) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO inventory_reservations (
      id, tenant_id, client_id, status, demand_type, demand_id, item_id,
      location_id, warehouse_id, uom, quantity_reserved, quantity_fulfilled,
      reserved_at, created_at, updated_at
    ) VALUES (
      $1, $2, $2, $3, 'sales_order_line', $4, $5,
      $6, $7, 'each', 1, 0,
      now(), now(), now()
    )`,
    [id, tenantId, status, randomUUID(), itemId, locationId, warehouseId]
  );
  return id;
}

async function fetchBlock(client, tenantId) {
  const res = await client.query(
    `SELECT tenant_id, code, active
       FROM inventory_invariant_blocks
      WHERE tenant_id = $1 AND code = 'RESERVATION_WAREHOUSE_HISTORICAL_MISMATCH'`,
    [tenantId]
  );
  return res.rows[0] ?? null;
}

test('detects reservation warehouse historical mismatch (warning only)', async () => {
  const client = await pool.connect();
  let tenantId;
  try {
    await client.query('BEGIN');
    tenantId = await insertTenant(client, 'mismatch');
    const w1 = await insertWarehouseRoot(client, tenantId, 'A');
    const w2 = await insertWarehouseRoot(client, tenantId, 'B');
    const parentB = await insertNode(client, tenantId, {
      parentId: w2.id,
      warehouseId: w2.id,
      label: 'B'
    });
    const loc = await insertNode(client, tenantId, {
      parentId: w1.id,
      warehouseId: w1.id,
      label: 'L'
    });
    const itemId = await insertItem(client, tenantId, 'X');
    await insertReservation(client, {
      tenantId,
      itemId,
      locationId: loc,
      warehouseId: w1.id
    });

    await client.query(
      `UPDATE locations
          SET parent_location_id = $1
        WHERE tenant_id = $2 AND id = $3`,
      [parentB, tenantId, loc]
    );
    await client.query('COMMIT');

    const results = await runInventoryInvariantCheck({ tenantIds: [tenantId] });
    const summary = results.find((row) => row.tenantId === tenantId);
    assert.equal(summary?.reservationWarehouseHistoricalMismatchCount, 1);

    const block = await fetchBlock(client, tenantId);
    assert.equal(block, null, `Unexpected block row: ${safeJson(block)}`);

    await client.query('BEGIN');
    await client.query(
      `UPDATE locations
          SET parent_location_id = $1
        WHERE tenant_id = $2 AND id = $3`,
      [w2.id, tenantId, loc]
    );
    await client.query('COMMIT');
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failures if not in a transaction
    }
    if (tenantId) {
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM inventory_reservations WHERE tenant_id = $1`, [tenantId]);
        await client.query(`DELETE FROM items WHERE tenant_id = $1`, [tenantId]);
        await client.query(`DELETE FROM locations WHERE tenant_id = $1`, [tenantId]);
        await client.query(`DELETE FROM inventory_invariant_blocks WHERE tenant_id = $1`, [tenantId]);
        await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
        await client.query('COMMIT');
      } catch {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback failures
        }
      }
    }
    client.release();
  }
});

test('does not report mismatch when reservation warehouse matches current location warehouse', async () => {
  const client = await pool.connect();
  let tenantId;
  try {
    await client.query('BEGIN');
    tenantId = await insertTenant(client, 'aligned');
    const w1 = await insertWarehouseRoot(client, tenantId, 'A');
    const loc = await insertNode(client, tenantId, {
      parentId: w1.id,
      warehouseId: w1.id,
      label: 'L'
    });
    const itemId = await insertItem(client, tenantId, 'Y');
    await insertReservation(client, {
      tenantId,
      itemId,
      locationId: loc,
      warehouseId: w1.id
    });
    await client.query('COMMIT');

    const results = await runInventoryInvariantCheck({ tenantIds: [tenantId] });
    const summary = results.find((row) => row.tenantId === tenantId);
    assert.equal(summary?.reservationWarehouseHistoricalMismatchCount ?? 0, 0);
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failures if not in a transaction
    }
    if (tenantId) {
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM inventory_reservations WHERE tenant_id = $1`, [tenantId]);
        await client.query(`DELETE FROM items WHERE tenant_id = $1`, [tenantId]);
        await client.query(`DELETE FROM locations WHERE tenant_id = $1`, [tenantId]);
        await client.query(`DELETE FROM inventory_invariant_blocks WHERE tenant_id = $1`, [tenantId]);
        await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
        await client.query('COMMIT');
      } catch {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback failures
        }
      }
    }
    client.release();
  }
});

test.after(async () => {
  await pool.end();
});
