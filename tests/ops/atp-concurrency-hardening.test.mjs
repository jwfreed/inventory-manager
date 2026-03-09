import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { buildAtpLockKeys } = require('../../src/domains/inventory/internal/atpLocks.ts');
const { ensureWarehouseDefaultsForWarehouse } = require('../../src/services/warehouseDefaults.service.ts');
const { withTransactionRetry } = require('../../src/db.ts');
const {
  __buildAtpRetryOptionsForTests,
  __mapAtpRetryErrorForTests,
  __setAtpMetricsSinkForTests,
  __setAtpRetryHooksForTests
} = require('../../src/services/orderToCash.service.ts');

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `atp-hardening-${randomUUID().slice(0, 8)}`;

async function apiRequest(method, path, { token, body, params, headers } = {}) {
  const url = new URL(baseUrl + path);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  const mergedHeaders = { 'Content-Type': 'application/json', Connection: 'close', ...(headers ?? {}) };
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
  return ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'ATP Concurrency Hardening Tenant'
  });
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
  assert.equal(itemRes.res.status, 201, JSON.stringify(itemRes.payload));
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
  assert.equal(adjustmentRes.res.status, 201, JSON.stringify(adjustmentRes.payload));
  const postRes = await apiRequest('POST', `/inventory-adjustments/${adjustmentRes.payload.id}/post`, { token });
  assert.equal(postRes.res.status, 200, JSON.stringify(postRes.payload));
}

async function createReservationRequest(token, reservation, idempotencyKey) {
  return apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: { reservations: [reservation] }
  });
}

async function createCustomer(tenantId, db) {
  const id = randomUUID();
  const code = `C-${randomUUID().slice(0, 8)}`;
  await db.query(
    `INSERT INTO customers (id, tenant_id, code, name, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, now(), now())`,
    [id, tenantId, code, `Customer ${code}`]
  );
  return id;
}

async function createSalesOrder(token, { customerId, itemId, quantityOrdered, shipFromLocationId, warehouseId }) {
  const soRes = await apiRequest('POST', '/sales-orders', {
    token,
    body: {
      soNumber: `SO-${randomUUID().slice(0, 8)}`,
      customerId,
      status: 'submitted',
      warehouseId,
      shipFromLocationId,
      lines: [{ itemId, uom: 'each', quantityOrdered }]
    }
  });
  assert.equal(soRes.res.status, 201, JSON.stringify(soRes.payload));
  return soRes.payload;
}

async function createShipment(token, { salesOrderId, salesOrderLineId, shipFromLocationId, quantityShipped }) {
  const shipmentRes = await apiRequest('POST', '/shipments', {
    token,
    body: {
      salesOrderId,
      shippedAt: new Date().toISOString(),
      shipFromLocationId,
      lines: [{ salesOrderLineId, uom: 'each', quantityShipped }]
    }
  });
  assert.equal(shipmentRes.res.status, 201, JSON.stringify(shipmentRes.payload));
  return shipmentRes.payload;
}

async function createWarehouseRootAndSellableDefault(db, tenantId, label) {
  const warehouseId = randomUUID();
  const codeSuffix = randomUUID().slice(0, 8);
  await db.query(
    `INSERT INTO locations (
        id, tenant_id, code, local_code, name, type, role, is_sellable, active,
        parent_location_id, warehouse_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'warehouse', NULL, false, true, NULL, $1, now(), now())`,
    [warehouseId, tenantId, `WH-${label}-${codeSuffix}`, `WH_${label}_${codeSuffix}`, `Warehouse ${label}`]
  );
  await ensureWarehouseDefaultsForWarehouse(tenantId, warehouseId, { repair: true });
  const sellableRes = await db.query(
    `SELECT d.location_id
       FROM warehouse_default_location d
      WHERE d.tenant_id = $1
        AND d.warehouse_id = $2
        AND d.role = 'SELLABLE'
      LIMIT 1`,
    [tenantId, warehouseId]
  );
  assert.equal(sellableRes.rowCount, 1, 'SELLABLE default missing for second warehouse');
  return {
    warehouseId,
    sellableLocationId: sellableRes.rows[0].location_id
  };
}

test('ATP retry jitter/exhaustion mapping stays deterministic and emits metrics', async () => {
  const sleepCalls = [];
  const metrics = [];
  const context = {
    operation: 'reserve',
    tenantId: '00000000-0000-0000-0000-000000000001',
    warehouseIds: ['00000000-0000-0000-0000-000000000010'],
    itemIds: ['00000000-0000-0000-0000-000000000100'],
    lockKeysCount: 1
  };

  __setAtpRetryHooksForTests({
    random: () => 0.4,
    sleep: async (delayMs) => {
      sleepCalls.push(delayMs);
    }
  });
  __setAtpMetricsSinkForTests((event, payload) => {
    metrics.push({ event, payload });
  });

  try {
    const retryOptions = __buildAtpRetryOptionsForTests(context, 2);
    let exhaustedError = null;
    try {
      await withTransactionRetry(async () => {
        const err = new Error('serialization_conflict');
        err.code = '40001';
        throw err;
      }, retryOptions);
      assert.fail('Expected TX_RETRY_EXHAUSTED');
    } catch (error) {
      exhaustedError = error;
    }

    assert.ok(exhaustedError, 'expected retry exhaustion error');
    assert.equal(exhaustedError.code, 'TX_RETRY_EXHAUSTED');
    assert.equal(exhaustedError.retrySqlState, '40001');
    assert.equal(exhaustedError.retryAttempts, 3);
    assert.deepEqual(
      sleepCalls,
      [7, 12],
      'bounded jitter/backoff should invoke deterministic sleep hooks for retry attempts'
    );

    const mapped = __mapAtpRetryErrorForTests(exhaustedError, context);
    assert.equal(mapped.code, 'ATP_CONCURRENCY_EXHAUSTED');
    assert.equal(mapped.status, 409);
    assert.equal(mapped.details?.reason, 'tx_retry_exhausted');
    assert.equal(mapped.details?.attempts, 3);
    assert.equal(mapped.details?.lockKeysCount, 1);
    assert.equal(mapped.details?.tenantId, context.tenantId);
    assert.equal(mapped.details?.warehouseId, context.warehouseIds[0]);
    assert.equal(mapped.details?.itemId, context.itemIds[0]);

    const retryAttemptMetrics = metrics.filter((entry) => entry.event === 'atp_tx_retry_attempts');
    assert.equal(retryAttemptMetrics.length, 2);
    assert.deepEqual(
      retryAttemptMetrics.map((entry) => entry.payload?.delayMs),
      [7, 12]
    );
    assert.ok(metrics.some((entry) => entry.event === 'atp_retry_count'));
    assert.ok(metrics.some((entry) => entry.event === 'atp_concurrency_exhausted_count'));
  } finally {
    __setAtpRetryHooksForTests();
    __setAtpMetricsSinkForTests(null);
  }
});

test('cross-warehouse ATP locks are independent for same tenant+item', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const first = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:cross-wh-a` });
  const second = await createWarehouseRootAndSellableDefault(db, tenantId, 'B');

  const itemId = await createItem(token, first.defaults.SELLABLE.id, 'XWH');
  await seedStock(token, itemId, first.defaults.SELLABLE.id, 5);
  await seedStock(token, itemId, second.sellableLocationId, 5);

  const [lockA] = buildAtpLockKeys([{
    tenantId,
    warehouseId: first.warehouse.id,
    itemId
  }]);
  const [lockB] = buildAtpLockKeys([{
    tenantId,
    warehouseId: second.warehouseId,
    itemId
  }]);
  assert.ok(lockA && lockB, 'expected lock keys for both warehouses');
  assert.notDeepEqual(
    [lockA.key1, lockA.key2],
    [lockB.key1, lockB.key2],
    'lock keys must differ across warehouses for same tenant+item'
  );

  const lockClient = await db.connect();
  let lockReleased = false;
  let blockedRequestResult;
  let independentRequestResult;
  let blockedDurationMs = 0;
  let independentDurationMs = 0;
  try {
    await lockClient.query('BEGIN');
    await lockClient.query(
      `SELECT pg_advisory_xact_lock($1::integer, $2::integer)`,
      [lockA.key1, lockA.key2]
    );

    const blockedPromise = (async () => {
      const startedAt = performance.now();
      const response = await createReservationRequest(
        token,
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId,
          warehouseId: first.warehouse.id,
          locationId: first.defaults.SELLABLE.id,
          uom: 'each',
          quantityReserved: 1,
          allowBackorder: false
        },
        `reserve-${randomUUID()}`
      );
      blockedDurationMs = performance.now() - startedAt;
      blockedRequestResult = response;
      return response;
    })();

    await new Promise((resolve) => setTimeout(resolve, 120));

    const independentPromise = (async () => {
      const startedAt = performance.now();
      const response = await createReservationRequest(
        token,
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId,
          warehouseId: second.warehouseId,
          locationId: second.sellableLocationId,
          uom: 'each',
          quantityReserved: 1,
          allowBackorder: false
        },
        `reserve-${randomUUID()}`
      );
      independentDurationMs = performance.now() - startedAt;
      independentRequestResult = response;
      return response;
    })();

    await new Promise((resolve) => setTimeout(resolve, 900));
    await lockClient.query('ROLLBACK');
    lockClient.release();
    lockReleased = true;

    await Promise.all([blockedPromise, independentPromise]);
  } finally {
    if (!lockReleased) {
      await lockClient.query('ROLLBACK');
      lockClient.release();
      lockReleased = true;
    }
  }

  assert.equal(blockedRequestResult.res.status, 201, JSON.stringify(blockedRequestResult.payload));
  assert.equal(independentRequestResult.res.status, 201, JSON.stringify(independentRequestResult.payload));
  assert.ok(blockedDurationMs >= 800, `expected blocked request baseline >= 800ms, got ${blockedDurationMs}`);
  assert.ok(
    independentDurationMs < blockedDurationMs * 0.75,
    `cross-warehouse request should complete meaningfully faster than blocked baseline: independent=${independentDurationMs}, blocked=${blockedDurationMs}`
  );

  const oversellRes = await db.query(
    `SELECT COUNT(*)::int AS oversell_count
       FROM inventory_available_location_v
      WHERE tenant_id = $1
        AND item_id = $2
        AND warehouse_id = ANY($3::uuid[])
        AND ((reserved_qty + allocated_qty) - on_hand_qty) > 1e-6`,
    [tenantId, itemId, [first.warehouse.id, second.warehouseId]]
  );
  assert.equal(Number(oversellRes.rows[0]?.oversell_count ?? 0), 0);
});

test('reversed multi-line reservations across mixed warehouses complete without deadlock', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const first = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:mixed-wh-a` });
  const second = await createWarehouseRootAndSellableDefault(db, tenantId, 'MIXEDB');

  const itemA = await createItem(token, first.defaults.SELLABLE.id, 'MXA');
  const itemB = await createItem(token, first.defaults.SELLABLE.id, 'MXB');
  await seedStock(token, itemA, first.defaults.SELLABLE.id, 5);
  await seedStock(token, itemB, second.sellableLocationId, 5);

  const lineA = {
    demandType: 'sales_order_line',
    demandId: randomUUID(),
    itemId: itemA,
    warehouseId: first.warehouse.id,
    locationId: first.defaults.SELLABLE.id,
    uom: 'each',
    quantityReserved: 1,
    allowBackorder: false
  };
  const lineB = {
    demandType: 'sales_order_line',
    demandId: randomUUID(),
    itemId: itemB,
    warehouseId: second.warehouseId,
    locationId: second.sellableLocationId,
    uom: 'each',
    quantityReserved: 1,
    allowBackorder: false
  };

  const reqForward = apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `reserve-${randomUUID()}` },
    body: { reservations: [lineA, lineB] }
  });
  const reqReverse = apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `reserve-${randomUUID()}` },
    body: { reservations: [lineB, lineA] }
  });

  const [forward, reverse] = await Promise.all([reqForward, reqReverse]);
  assert.equal(forward.res.status, 201, `forward status=${forward.res.status} body=${JSON.stringify(forward.payload)}`);
  assert.equal(reverse.res.status, 201, `reverse status=${reverse.res.status} body=${JSON.stringify(reverse.payload)}`);
  assert.equal(Array.isArray(forward.payload?.data), true);
  assert.equal(Array.isArray(reverse.payload?.data), true);
  assert.equal(forward.payload.data.length, 2);
  assert.equal(reverse.payload.data.length, 2);

  const oversellRes = await db.query(
    `SELECT COUNT(*)::int AS oversell_count
       FROM inventory_available_location_v
      WHERE tenant_id = $1
        AND (
          (warehouse_id = $2 AND item_id = $3 AND location_id = $4)
          OR
          (warehouse_id = $5 AND item_id = $6 AND location_id = $7)
        )
        AND ((reserved_qty + allocated_qty) - on_hand_qty) > 1e-6`,
    [
      tenantId,
      first.warehouse.id,
      itemA,
      first.defaults.SELLABLE.id,
      second.warehouseId,
      itemB,
      second.sellableLocationId
    ]
  );
  assert.equal(Number(oversellRes.rows[0]?.oversell_count ?? 0), 0);
});

test('shipment-vs-reservation race stays deterministic and prevents oversell', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({
    token,
    apiRequest,
    scope: `${import.meta.url}:shipment-race`
  });
  const sellable = defaults.SELLABLE;
  const itemId = await createItem(token, sellable.id, 'SHIPRACE');
  await seedStock(token, itemId, sellable.id, 3);

  const customerId = await createCustomer(tenantId, db);
  const order = await createSalesOrder(token, {
    customerId,
    itemId,
    quantityOrdered: 2,
    shipFromLocationId: sellable.id,
    warehouseId: warehouse.id
  });
  const lineId = order.lines[0]?.id;
  assert.ok(lineId, 'sales order line id missing');

  const reserveForLine = await createReservationRequest(
    token,
    {
      demandType: 'sales_order_line',
      demandId: lineId,
      itemId,
      warehouseId: warehouse.id,
      locationId: sellable.id,
      uom: 'each',
      quantityReserved: 2,
      allowBackorder: false
    },
    `reserve-${randomUUID()}`
  );
  assert.equal(reserveForLine.res.status, 201, JSON.stringify(reserveForLine.payload));
  const reservedId = reserveForLine.payload.data[0]?.id;
  assert.ok(reservedId, 'reservation id missing');

  const allocateRes = await apiRequest('POST', `/reservations/${reservedId}/allocate`, {
    token,
    headers: { 'Idempotency-Key': `allocate-${randomUUID()}` },
    body: { warehouseId: warehouse.id }
  });
  assert.equal(allocateRes.res.status, 200, JSON.stringify(allocateRes.payload));

  const shipment = await createShipment(token, {
    salesOrderId: order.id,
    salesOrderLineId: lineId,
    shipFromLocationId: sellable.id,
    quantityShipped: 2
  });

  const [postRes, competingReserveRes] = await Promise.all([
    apiRequest('POST', `/shipments/${shipment.id}/post`, {
      token,
      headers: { 'Idempotency-Key': `ship-${randomUUID()}` },
      body: {}
    }),
    createReservationRequest(
      token,
      {
        demandType: 'sales_order_line',
        demandId: randomUUID(),
        itemId,
        warehouseId: warehouse.id,
        locationId: sellable.id,
        uom: 'each',
        quantityReserved: 2,
        allowBackorder: false
      },
      `reserve-${randomUUID()}`
    )
  ]);

  assert.ok([200, 409].includes(postRes.res.status), `unexpected shipment status=${postRes.res.status}`);
  if (postRes.res.status === 409) {
    assert.equal(postRes.payload?.error?.code, 'ATP_CONCURRENCY_EXHAUSTED');
  }
  assert.equal(competingReserveRes.res.status, 409, JSON.stringify(competingReserveRes.payload));
  assert.ok(
    ['ATP_INSUFFICIENT_AVAILABLE', 'ATP_CONCURRENCY_EXHAUSTED'].includes(competingReserveRes.payload?.error?.code),
    `unexpected competing reservation code=${competingReserveRes.payload?.error?.code}`
  );

  const balanceRes = await db.query(
    `SELECT on_hand, reserved, allocated
       FROM inventory_balance
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = 'each'
      LIMIT 1`,
    [tenantId, itemId, sellable.id]
  );
  assert.equal(balanceRes.rowCount, 1);
  const onHand = Number(balanceRes.rows[0].on_hand);
  const reserved = Number(balanceRes.rows[0].reserved);
  const allocated = Number(balanceRes.rows[0].allocated);
  assert.ok(onHand >= -1e-6, `on_hand must be non-negative, got ${onHand}`);
  assert.ok(reserved >= -1e-6, `reserved must be non-negative, got ${reserved}`);
  assert.ok(allocated >= -1e-6, `allocated must be non-negative, got ${allocated}`);
  assert.ok(reserved + allocated <= onHand + 1e-6, `committed exceeds on_hand: ${reserved + allocated} > ${onHand}`);

  const oversellRes = await db.query(
    `SELECT COUNT(*)::int AS oversell_count
       FROM inventory_available_location_v
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND item_id = $3
        AND location_id = $4
        AND uom = 'each'
        AND ((reserved_qty + allocated_qty) - on_hand_qty) > 1e-6`,
    [tenantId, warehouse.id, itemId, sellable.id]
  );
  assert.equal(Number(oversellRes.rows[0]?.oversell_count ?? 0), 0);
});
