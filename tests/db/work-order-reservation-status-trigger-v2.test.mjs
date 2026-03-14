import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || 'postgres://jonathanfreed@localhost:5432/inventory_manager_dev';

const db = new Pool({ connectionString: databaseUrl });

test.after(async () => {
  await db.end();
});

async function withTx(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertTenant(client, label) {
  const tenantId = randomUUID();
  await client.query(
    `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
     VALUES ($1, $2, $3, NULL, now())`,
    [tenantId, `WO Reservation Trigger ${label}`, `wo-res-trigger-${label}-${randomUUID().slice(0, 8)}`]
  );
  return tenantId;
}

async function insertWarehouse(client, tenantId) {
  const warehouseId = randomUUID();
  await client.query(
    `INSERT INTO locations (
        id, tenant_id, code, name, type, active, created_at, updated_at,
        role, is_sellable, parent_location_id, warehouse_id
      ) VALUES (
        $1, $2, $3, $4, 'warehouse', true, now(), now(),
        NULL, false, NULL, $1
      )`,
    [warehouseId, tenantId, `WH-${randomUUID().slice(0, 8)}`, `Warehouse ${warehouseId.slice(0, 8)}`]
  );
  return warehouseId;
}

async function insertSellableBin(client, tenantId, warehouseId) {
  const locationId = randomUUID();
  await client.query(
    `INSERT INTO locations (
        id, tenant_id, code, name, type, active, created_at, updated_at,
        role, is_sellable, parent_location_id, warehouse_id
      ) VALUES (
        $1, $2, $3, $4, 'bin', true, now(), now(),
        'SELLABLE', true, $5, $5
      )`,
    [locationId, tenantId, `BIN-${randomUUID().slice(0, 8)}`, `Sellable ${locationId.slice(0, 8)}`, warehouseId]
  );
  return locationId;
}

async function insertItem(client, tenantId, locationId, prefix) {
  const itemId = randomUUID();
  await client.query(
    `INSERT INTO items (
        id,
        sku,
        name,
        active,
        created_at,
        updated_at,
        type,
        tenant_id,
        lifecycle_status,
        is_phantom,
        uom_dimension,
        canonical_uom,
        stocking_uom,
        requires_lot,
        requires_serial,
        requires_qc,
        is_purchasable,
        is_manufactured,
        default_location_id
      ) VALUES (
        $1,
        $2,
        $3,
        true,
        now(),
        now(),
        'raw',
        $4,
        'Active',
        false,
        'count',
        'each',
        'each',
        false,
        false,
        false,
        true,
        false,
        $5
      )`,
    [itemId, `${prefix}-${randomUUID().slice(0, 8)}`, `Item ${prefix}`, tenantId, locationId]
  );
  return itemId;
}

async function insertReservation(client, {
  tenantId,
  reservationId,
  demandType,
  demandId,
  itemId,
  locationId,
  warehouseId,
  status,
  quantityReserved,
  quantityFulfilled
}) {
  await client.query(
    `INSERT INTO inventory_reservations (
        id,
        tenant_id,
        client_id,
        status,
        demand_type,
        demand_id,
        item_id,
        location_id,
        warehouse_id,
        uom,
        quantity_reserved,
        quantity_fulfilled,
        reserved_at,
        created_at,
        updated_at
      ) VALUES (
        $1,
        $2,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        'each',
        $9,
        $10,
        now(),
        now(),
        now()
      )`,
    [
      reservationId,
      tenantId,
      status,
      demandType,
      demandId,
      itemId,
      locationId,
      warehouseId,
      quantityReserved,
      quantityFulfilled
    ]
  );
}

async function createFixture(client, label) {
  const tenantId = await insertTenant(client, label);
  const warehouseId = await insertWarehouse(client, tenantId);
  const locationId = await insertSellableBin(client, tenantId, warehouseId);
  const itemId = await insertItem(client, tenantId, locationId, label.toUpperCase());
  return { tenantId, warehouseId, locationId, itemId };
}

test('work-order reservation trigger derives active status from fulfillment quantities and overrides caller input', async () => {
  await withTx(async (client) => {
    const { tenantId, warehouseId, locationId, itemId } = await createFixture(client, 'derive');
    const reservationId = randomUUID();

    await insertReservation(client, {
      tenantId,
      reservationId,
      demandType: 'work_order_component',
      demandId: randomUUID(),
      itemId,
      locationId,
      warehouseId,
      status: 'FULFILLED',
      quantityReserved: 10,
      quantityFulfilled: 10
    });

    const partial = await client.query(
      `UPDATE inventory_reservations
          SET quantity_fulfilled = 4,
              status = 'RESERVED',
              updated_at = now()
        WHERE id = $1
          AND tenant_id = $2
      RETURNING status, quantity_reserved::numeric AS quantity_reserved, quantity_fulfilled::numeric AS quantity_fulfilled`,
      [reservationId, tenantId]
    );
    assert.equal(partial.rows[0]?.status, 'ALLOCATED');
    assert.equal(Number(partial.rows[0]?.quantity_reserved ?? 0), 10);
    assert.equal(Number(partial.rows[0]?.quantity_fulfilled ?? 0), 4);

    const reopened = await client.query(
      `UPDATE inventory_reservations
          SET quantity_fulfilled = 0,
              status = 'ALLOCATED',
              updated_at = now()
        WHERE id = $1
          AND tenant_id = $2
      RETURNING status, quantity_fulfilled::numeric AS quantity_fulfilled`,
      [reservationId, tenantId]
    );
    assert.equal(reopened.rows[0]?.status, 'RESERVED');
    assert.equal(Number(reopened.rows[0]?.quantity_fulfilled ?? 0), 0);
  });
});

test('work-order fulfilled reservations only reopen on downward fulfillment movement', async () => {
  await withTx(async (client) => {
    const { tenantId, warehouseId, locationId, itemId } = await createFixture(client, 'guard');
    const reservationId = randomUUID();

    await insertReservation(client, {
      tenantId,
      reservationId,
      demandType: 'work_order_component',
      demandId: randomUUID(),
      itemId,
      locationId,
      warehouseId,
      status: 'FULFILLED',
      quantityReserved: 10,
      quantityFulfilled: 10
    });

    await assert.rejects(
      client.query(
        `UPDATE inventory_reservations
            SET quantity_reserved = 15,
                status = 'RESERVED',
                updated_at = now()
          WHERE id = $1
            AND tenant_id = $2`,
        [reservationId, tenantId]
      ),
      (error) => String(error?.message ?? '').includes('RESERVATION_TERMINAL_STATE')
    );
  });
});

test('non-work-order reservations retain explicit allocation semantics', async () => {
  await withTx(async (client) => {
    const { tenantId, warehouseId, locationId, itemId } = await createFixture(client, 'sales');
    const reservationId = randomUUID();

    await insertReservation(client, {
      tenantId,
      reservationId,
      demandType: 'sales_order_line',
      demandId: randomUUID(),
      itemId,
      locationId,
      warehouseId,
      status: 'RESERVED',
      quantityReserved: 10,
      quantityFulfilled: 0
    });

    const allocated = await client.query(
      `UPDATE inventory_reservations
          SET status = 'ALLOCATED',
              updated_at = now()
        WHERE id = $1
          AND tenant_id = $2
      RETURNING status, quantity_fulfilled::numeric AS quantity_fulfilled`,
      [reservationId, tenantId]
    );
    assert.equal(allocated.rows[0]?.status, 'ALLOCATED');
    assert.equal(Number(allocated.rows[0]?.quantity_fulfilled ?? 0), 0);
  });
});
