import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import { waitForCondition } from '../api/helpers/waitFor.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `wh-avail-${randomUUID().slice(0, 8)}`;
const openPools = new Set();

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

async function getSession() {
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Warehouse Availability Unification Tenant'
  });
  if (session.pool) openPools.add(session.pool);
  return session;
}

test.after(async () => {
  await Promise.all(
    Array.from(openPools).map(async (pool) => {
      try {
        await pool.end();
      } catch {
        // Ignore pool shutdown errors during teardown.
      }
    })
  );
  openPools.clear();
});

async function createWarehouseWithSellable(token, suffix) {
  const warehouseRes = await apiRequest('POST', '/locations', {
    token,
    body: {
      code: `WH-${suffix}-${randomUUID().slice(0, 4)}`,
      name: `Warehouse ${suffix}`,
      type: 'warehouse',
      active: true
    }
  });
  assert.equal(warehouseRes.res.status, 201);
  const warehouse = warehouseRes.payload;

  const sellableRes = await apiRequest('POST', '/locations', {
    token,
    body: {
      code: `SELL-${suffix}-${randomUUID().slice(0, 4)}`,
      name: `Sellable ${suffix}`,
      type: 'bin',
      role: 'SELLABLE',
      isSellable: true,
      active: true,
      parentLocationId: warehouse.id
    }
  });
  assert.equal(sellableRes.res.status, 201);
  return { warehouse, sellable: sellableRes.payload };
}

async function createItem(token, defaultLocationId, suffix = 'ITEM') {
  const sku = `${suffix}-${randomUUID().slice(0, 8)}`;
  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId
    }
  });
  assert.equal(itemRes.res.status, 201);
  return itemRes.payload.id;
}

async function seedStock(token, itemId, locationId, quantity) {
  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      reasonCode: 'seed',
      lines: [
        {
          lineNumber: 1,
          itemId,
          locationId,
          uom: 'each',
          quantityDelta: quantity,
          reasonCode: 'seed'
        }
      ]
    }
  });
  assert.equal(adjustmentRes.res.status, 201);
  const postRes = await apiRequest('POST', `/inventory-adjustments/${adjustmentRes.payload.id}/post`, { token });
  assert.equal(postRes.res.status, 200);
}

async function createReservation(token, { warehouseId, itemId, locationId, quantity }) {
  const res = await apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `reserve-${randomUUID()}` },
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId,
          warehouseId,
          locationId,
          uom: 'each',
          quantityReserved: quantity,
          allowBackorder: false
        }
      ]
    }
  });
  assert.equal(res.res.status, 201);
  return res.payload.data[0].id;
}

test('mandatory warehouseId validation returns 400 WAREHOUSE_ID_REQUIRED', async () => {
  const session = await getSession();
  const token = session.accessToken;
  assert.ok(token);

  const atpRes = await apiRequest('GET', '/atp', {
    token,
    params: { itemId: randomUUID() }
  });
  assert.equal(atpRes.res.status, 400);
  assert.equal(atpRes.payload?.error?.code, 'WAREHOUSE_ID_REQUIRED');

  const snapshotRes = await apiRequest('GET', '/inventory-snapshot', {
    token,
    params: { itemId: randomUUID(), locationId: randomUUID() }
  });
  assert.equal(snapshotRes.res.status, 400);
  assert.equal(snapshotRes.payload?.error?.code, 'WAREHOUSE_ID_REQUIRED');

  const reservationRes = await apiRequest('POST', '/reservations', {
    token,
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId: randomUUID(),
          locationId: randomUUID(),
          uom: 'each',
          quantityReserved: 1
        }
      ]
    }
  });
  assert.equal(reservationRes.res.status, 400);
  assert.equal(reservationRes.payload?.error?.code, 'WAREHOUSE_ID_REQUIRED');
});

test('canonical availability is exact on_hand - reserved - allocated', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const sellable = defaults.SELLABLE;

  const itemId = await createItem(token, sellable.id, 'CANON');
  await seedStock(token, itemId, sellable.id, 10);

  await createReservation(token, {
    warehouseId: warehouse.id,
    itemId,
    locationId: sellable.id,
    quantity: 3
  });
  const allocReservationId = await createReservation(token, {
    warehouseId: warehouse.id,
    itemId,
    locationId: sellable.id,
    quantity: 2
  });

  const allocateRes = await apiRequest('POST', `/reservations/${allocReservationId}/allocate`, {
    token,
    headers: { 'Idempotency-Key': `alloc-${randomUUID()}` },
    body: { warehouseId: warehouse.id }
  });
  assert.equal(allocateRes.res.status, 200);

  await waitForCondition(
    async () => {
      const detail = await apiRequest('GET', '/atp/detail', {
        token,
        params: {
          warehouseId: warehouse.id,
          itemId,
          locationId: sellable.id,
          uom: 'each'
        }
      });
      if (detail.res.status !== 200) return null;
      return detail.payload?.data ?? null;
    },
    (row) =>
      row &&
      Math.abs(Number(row.onHand) - 10) < 1e-6 &&
      Math.abs(Number(row.reserved) - 3) < 1e-6 &&
      Math.abs(Number(row.allocated) - 2) < 1e-6 &&
      Math.abs(Number(row.availableToPromise) - 5) < 1e-6,
    { label: 'canonical availability from ATP detail' }
  );

  const canonicalRes = await db.query(
    `SELECT on_hand, reserved, allocated, available
       FROM inventory_availability_location_v
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND item_id = $3
        AND location_id = $4
        AND uom = 'each'`,
    [tenantId, warehouse.id, itemId, sellable.id]
  );
  assert.equal(canonicalRes.rowCount, 1);
  assert.ok(Math.abs(Number(canonicalRes.rows[0].on_hand) - 10) < 1e-6);
  assert.ok(Math.abs(Number(canonicalRes.rows[0].reserved) - 3) < 1e-6);
  assert.ok(Math.abs(Number(canonicalRes.rows[0].allocated) - 2) < 1e-6);
  assert.ok(Math.abs(Number(canonicalRes.rows[0].available) - 5) < 1e-6);

  const warehouseRes = await db.query(
    `SELECT on_hand, reserved, allocated, available
       FROM inventory_availability_v
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND item_id = $3
        AND uom = 'each'`,
    [tenantId, warehouse.id, itemId]
  );
  assert.equal(warehouseRes.rowCount, 1);
  assert.ok(Math.abs(Number(warehouseRes.rows[0].on_hand) - 10) < 1e-6);
  assert.ok(Math.abs(Number(warehouseRes.rows[0].reserved) - 3) < 1e-6);
  assert.ok(Math.abs(Number(warehouseRes.rows[0].allocated) - 2) < 1e-6);
  assert.ok(Math.abs(Number(warehouseRes.rows[0].available) - 5) < 1e-6);
});

test('warehouse-scoped ATP isolates stock between warehouses', async () => {
  const session = await getSession();
  const token = session.accessToken;
  assert.ok(token);

  const scopedA = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:A` });
  const scopedB = await createWarehouseWithSellable(token, 'B');

  const itemId = await createItem(token, scopedA.defaults.SELLABLE.id, 'ISO');
  await seedStock(token, itemId, scopedA.defaults.SELLABLE.id, 5);
  await seedStock(token, itemId, scopedB.sellable.id, 7);

  const atpA = await apiRequest('GET', '/atp', {
    token,
    params: { warehouseId: scopedA.warehouse.id, itemId }
  });
  assert.equal(atpA.res.status, 200);
  const rowsA = atpA.payload?.data ?? [];
  assert.ok(rowsA.length > 0);
  assert.ok(rowsA.every((row) => row.locationId !== scopedB.sellable.id));
  const onHandA = rowsA.reduce((sum, row) => sum + Number(row.onHand || 0), 0);
  assert.ok(Math.abs(onHandA - 5) < 1e-6);

  const atpB = await apiRequest('GET', '/atp', {
    token,
    params: { warehouseId: scopedB.warehouse.id, itemId }
  });
  assert.equal(atpB.res.status, 200);
  const rowsB = atpB.payload?.data ?? [];
  assert.ok(rowsB.length > 0);
  assert.ok(rowsB.every((row) => row.locationId !== scopedA.defaults.SELLABLE.id));
  const onHandB = rowsB.reduce((sum, row) => sum + Number(row.onHand || 0), 0);
  assert.ok(Math.abs(onHandB - 7) < 1e-6);
});

test('ATP exposes SELLABLE-only quantities when non-sellable stock exists', async () => {
  const session = await getSession();
  const token = session.accessToken;
  assert.ok(token);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:sellable-only` });
  const sellable = defaults.SELLABLE;
  const qa = defaults.QA;

  const itemId = await createItem(token, sellable.id, 'SELLONLY');
  await seedStock(token, itemId, qa.id, 10);
  await seedStock(token, itemId, sellable.id, 5);

  await waitForCondition(
    async () => {
      const atpRes = await apiRequest('GET', '/atp', {
        token,
        params: { warehouseId: warehouse.id, itemId }
      });
      if (atpRes.res.status !== 200) return null;
      return atpRes.payload?.data ?? [];
    },
    (rows) => {
      if (!rows || !rows.length) return false;
      if (!rows.every((row) => row.locationId === sellable.id)) return false;
      const onHand = rows.reduce((sum, row) => sum + Number(row.onHand || 0), 0);
      const available = rows.reduce((sum, row) => sum + Number(row.availableToPromise || 0), 0);
      return Math.abs(onHand - 5) < 1e-6 && Math.abs(available - 5) < 1e-6;
    },
    { label: 'sellable-only ATP invariant' }
  );
});

test('sellable warehouse view equals sum of sellable location view for same item/uom', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:sellable-consistency` });
  const sellable = defaults.SELLABLE;
  const qa = defaults.QA;

  const itemId = await createItem(token, sellable.id, 'SELLCONSIST');
  await seedStock(token, itemId, sellable.id, 9);
  await seedStock(token, itemId, qa.id, 6);

  await createReservation(token, {
    warehouseId: warehouse.id,
    itemId,
    locationId: sellable.id,
    quantity: 2
  });
  const allocReservationId = await createReservation(token, {
    warehouseId: warehouse.id,
    itemId,
    locationId: sellable.id,
    quantity: 1
  });

  const allocateRes = await apiRequest('POST', `/reservations/${allocReservationId}/allocate`, {
    token,
    headers: { 'Idempotency-Key': `alloc-${randomUUID()}` },
    body: { warehouseId: warehouse.id }
  });
  assert.equal(allocateRes.res.status, 200);

  await waitForCondition(
    async () => {
      const sellableWarehouse = await db.query(
        `SELECT on_hand, reserved, allocated, available
           FROM inventory_availability_sellable_v
          WHERE tenant_id = $1
            AND warehouse_id = $2
            AND item_id = $3
            AND uom = 'each'`,
        [tenantId, warehouse.id, itemId]
      );
      if (!sellableWarehouse.rowCount) return null;
      return sellableWarehouse.rows[0];
    },
    (row) =>
      row &&
      Math.abs(Number(row.on_hand) - 9) < 1e-6 &&
      Math.abs(Number(row.reserved) - 2) < 1e-6 &&
      Math.abs(Number(row.allocated) - 1) < 1e-6 &&
      Math.abs(Number(row.available) - 6) < 1e-6,
    { label: 'sellable view consistency' }
  );

  const sellableLocationSum = await db.query(
    `SELECT COALESCE(SUM(on_hand), 0) AS on_hand,
            COALESCE(SUM(reserved), 0) AS reserved,
            COALESCE(SUM(allocated), 0) AS allocated,
            COALESCE(SUM(available), 0) AS available
       FROM inventory_availability_location_sellable_v
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND item_id = $3
        AND uom = 'each'`,
    [tenantId, warehouse.id, itemId]
  );

  const sellableWarehouse = await db.query(
    `SELECT on_hand, reserved, allocated, available
       FROM inventory_availability_sellable_v
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND item_id = $3
        AND uom = 'each'`,
    [tenantId, warehouse.id, itemId]
  );

  assert.equal(sellableWarehouse.rowCount, 1);
  assert.ok(Math.abs(Number(sellableLocationSum.rows[0].on_hand) - Number(sellableWarehouse.rows[0].on_hand)) < 1e-6);
  assert.ok(Math.abs(Number(sellableLocationSum.rows[0].reserved) - Number(sellableWarehouse.rows[0].reserved)) < 1e-6);
  assert.ok(Math.abs(Number(sellableLocationSum.rows[0].allocated) - Number(sellableWarehouse.rows[0].allocated)) < 1e-6);
  assert.ok(Math.abs(Number(sellableLocationSum.rows[0].available) - Number(sellableWarehouse.rows[0].available)) < 1e-6);
});

test('warehouse view equals sum of location view for same item/uom', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:consistency` });
  const sellable = defaults.SELLABLE;
  const qa = defaults.QA;

  const itemId = await createItem(token, sellable.id, 'CONSIST');
  await seedStock(token, itemId, sellable.id, 11);
  await seedStock(token, itemId, qa.id, 4);

  await createReservation(token, {
    warehouseId: warehouse.id,
    itemId,
    locationId: sellable.id,
    quantity: 3
  });

  const allocatedReservationId = await createReservation(token, {
    warehouseId: warehouse.id,
    itemId,
    locationId: sellable.id,
    quantity: 2
  });

  const allocateRes = await apiRequest('POST', `/reservations/${allocatedReservationId}/allocate`, {
    token,
    headers: { 'Idempotency-Key': `alloc-${randomUUID()}` },
    body: { warehouseId: warehouse.id }
  });
  assert.equal(allocateRes.res.status, 200);

  await waitForCondition(
    async () => {
      const warehouseRes = await db.query(
        `SELECT on_hand, reserved, allocated, available
           FROM inventory_availability_v
          WHERE tenant_id = $1
            AND warehouse_id = $2
            AND item_id = $3
            AND uom = 'each'`,
        [tenantId, warehouse.id, itemId]
      );
      if (!warehouseRes.rowCount) return null;
      return warehouseRes.rows[0];
    },
    (row) =>
      row &&
      Math.abs(Number(row.on_hand) - 15) < 1e-6 &&
      Math.abs(Number(row.reserved) - 3) < 1e-6 &&
      Math.abs(Number(row.allocated) - 2) < 1e-6 &&
      Math.abs(Number(row.available) - 10) < 1e-6,
    { label: 'warehouse availability consistency' }
  );

  const summedLocations = await db.query(
    `SELECT COALESCE(SUM(on_hand), 0) AS on_hand,
            COALESCE(SUM(reserved), 0) AS reserved,
            COALESCE(SUM(allocated), 0) AS allocated,
            COALESCE(SUM(available), 0) AS available
       FROM inventory_availability_location_v
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND item_id = $3
        AND uom = 'each'`,
    [tenantId, warehouse.id, itemId]
  );
  const warehouseAgg = await db.query(
    `SELECT on_hand, reserved, allocated, available
       FROM inventory_availability_v
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND item_id = $3
        AND uom = 'each'`,
    [tenantId, warehouse.id, itemId]
  );

  assert.equal(warehouseAgg.rowCount, 1);
  assert.ok(Math.abs(Number(summedLocations.rows[0].on_hand) - Number(warehouseAgg.rows[0].on_hand)) < 1e-6);
  assert.ok(Math.abs(Number(summedLocations.rows[0].reserved) - Number(warehouseAgg.rows[0].reserved)) < 1e-6);
  assert.ok(Math.abs(Number(summedLocations.rows[0].allocated) - Number(warehouseAgg.rows[0].allocated)) < 1e-6);
  assert.ok(Math.abs(Number(summedLocations.rows[0].available) - Number(warehouseAgg.rows[0].available)) < 1e-6);
});
