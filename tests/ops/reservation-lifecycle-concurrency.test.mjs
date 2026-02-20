import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `res-lifecycle-${randomUUID().slice(0, 8)}`;
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
    tenantName: 'Reservation Lifecycle Concurrency Tenant'
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
        // Ignore shutdown issues in teardown.
      }
    })
  );
  openPools.clear();
});

function nearlyEqual(left, right, epsilon = 1e-6) {
  return Math.abs(left - right) <= epsilon;
}

async function createItem(token, defaultLocationId, prefix = 'ITEM') {
  const sku = `${prefix}-${randomUUID().slice(0, 8)}`;
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

async function createReservation(token, { warehouseId, locationId, itemId, quantityReserved }) {
  return createReservationForDemand(token, {
    warehouseId,
    locationId,
    itemId,
    quantityReserved,
    demandId: randomUUID()
  });
}

async function createReservationForDemand(
  token,
  { warehouseId, locationId, itemId, quantityReserved, demandId }
) {
  const reservationRes = await apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `reserve-${randomUUID()}` },
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId,
          itemId,
          warehouseId,
          locationId,
          uom: 'each',
          quantityReserved,
          allowBackorder: false
        }
      ]
    }
  });
  assert.equal(reservationRes.res.status, 201, JSON.stringify(reservationRes.payload));
  return reservationRes.payload.data[0];
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

async function fetchReservation(token, reservationId, warehouseId) {
  const res = await apiRequest('GET', `/reservations/${reservationId}`, {
    token,
    params: { warehouseId }
  });
  assert.equal(res.res.status, 200, JSON.stringify(res.payload));
  return res.payload;
}

async function fetchBalance(db, tenantId, itemId, locationId, uom = 'each') {
  const res = await db.query(
    `SELECT on_hand, reserved, allocated
       FROM inventory_balance
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = $4`,
    [tenantId, itemId, locationId, uom]
  );
  assert.equal(res.rowCount, 1);
  return {
    onHand: Number(res.rows[0].on_hand),
    reserved: Number(res.rows[0].reserved),
    allocated: Number(res.rows[0].allocated)
  };
}

async function fetchTransitionEvents(db, tenantId, reservationId) {
  const res = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE event_type = 'ALLOCATED') AS allocated_events,
       COUNT(*) FILTER (WHERE event_type = 'CANCELLED') AS cancelled_events,
       COALESCE(SUM(CASE WHEN event_type = 'FULFILLED' THEN -delta_allocated ELSE 0 END), 0) AS fulfilled_delta
     FROM reservation_events
     WHERE tenant_id = $1
       AND reservation_id = $2`,
    [tenantId, reservationId]
  );
  return {
    allocatedEvents: Number(res.rows[0].allocated_events ?? 0),
    cancelledEvents: Number(res.rows[0].cancelled_events ?? 0),
    fulfilledDelta: Number(res.rows[0].fulfilled_delta ?? 0)
  };
}

async function fetchOpenCommitments(db, tenantId, warehouseId, itemId, locationId, uom = 'each') {
  const res = await db.query(
    `SELECT
       COALESCE(
         SUM(
           CASE
             WHEN status = 'RESERVED'
             THEN GREATEST(0, quantity_reserved - COALESCE(quantity_fulfilled, 0))
             ELSE 0
           END
         ),
         0
       ) AS reserved_open,
       COALESCE(
         SUM(
           CASE
             WHEN status = 'ALLOCATED'
             THEN GREATEST(0, quantity_reserved - COALESCE(quantity_fulfilled, 0))
             ELSE 0
           END
         ),
         0
       ) AS allocated_open
     FROM inventory_reservations
    WHERE tenant_id = $1
      AND warehouse_id = $2
      AND item_id = $3
      AND location_id = $4
      AND uom = $5`,
    [tenantId, warehouseId, itemId, locationId, uom]
  );
  return {
    reservedOpen: Number(res.rows[0]?.reserved_open ?? 0),
    allocatedOpen: Number(res.rows[0]?.allocated_open ?? 0)
  };
}

async function timedRequest(requestPromise, label, timeoutMs = 15000) {
  return Promise.race([
    requestPromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), timeoutMs)
    )
  ]);
}

test('allocate vs cancel race remains balance-consistent under allocated-cancel policy', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:alloc-cancel-race` });
  const sellable = defaults.SELLABLE;
  const itemId = await createItem(token, sellable.id, 'ALCN');
  await seedStock(token, itemId, sellable.id, 10);

  const reservation = await createReservation(token, {
    warehouseId: warehouse.id,
    locationId: sellable.id,
    itemId,
    quantityReserved: 4
  });

  const allocateReq = apiRequest('POST', `/reservations/${reservation.id}/allocate`, {
    token,
    headers: { 'Idempotency-Key': `allocate-${randomUUID()}` },
    body: { warehouseId: warehouse.id }
  });
  const cancelReq = apiRequest('POST', `/reservations/${reservation.id}/cancel`, {
    token,
    headers: { 'Idempotency-Key': `cancel-${randomUUID()}` },
    body: { warehouseId: warehouse.id, reason: 'race-test' }
  });
  const [allocateRes, cancelRes] = await Promise.all([allocateReq, cancelReq]);
  const statuses = [allocateRes.res.status, cancelRes.res.status];
  const allowedStatuses = new Set([200, 409]);
  assert.ok(allowedStatuses.has(statuses[0]), `unexpected allocate status ${statuses[0]}`);
  assert.ok(allowedStatuses.has(statuses[1]), `unexpected cancel status ${statuses[1]}`);
  assert.ok(statuses.includes(200), `expected at least one success, got ${statuses.join(', ')}`);

  const finalReservation = await fetchReservation(token, reservation.id, warehouse.id);
  if (cancelRes.res.status === 200) {
    assert.equal(finalReservation.status, 'CANCELLED');
  } else {
    assert.equal(finalReservation.status, 'ALLOCATED');
  }

  const transitions = await fetchTransitionEvents(db, tenantId, reservation.id);
  assert.ok(transitions.allocatedEvents <= 1, `allocated transition should be <= 1, got ${transitions.allocatedEvents}`);
  assert.ok(transitions.cancelledEvents <= 1, `cancel transition should be <= 1, got ${transitions.cancelledEvents}`);

  const balance = await fetchBalance(db, tenantId, itemId, sellable.id, 'each');
  assert.ok(nearlyEqual(balance.reserved, 0), `reserved expected 0, got ${balance.reserved}`);
  if (finalReservation.status === 'CANCELLED') {
    assert.ok(nearlyEqual(balance.allocated, 0), `allocated expected 0, got ${balance.allocated}`);
  } else {
    assert.ok(nearlyEqual(balance.allocated, 4), `allocated expected 4, got ${balance.allocated}`);
  }
});

test('double allocate: one success, one invalid state, no double delta', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:double-allocate` });
  const sellable = defaults.SELLABLE;
  const itemId = await createItem(token, sellable.id, 'DBLA');
  await seedStock(token, itemId, sellable.id, 8);

  const reservation = await createReservation(token, {
    warehouseId: warehouse.id,
    locationId: sellable.id,
    itemId,
    quantityReserved: 3
  });

  const [first, second] = await Promise.all([
    apiRequest('POST', `/reservations/${reservation.id}/allocate`, {
      token,
      headers: { 'Idempotency-Key': `allocate-${randomUUID()}` },
      body: { warehouseId: warehouse.id }
    }),
    apiRequest('POST', `/reservations/${reservation.id}/allocate`, {
      token,
      headers: { 'Idempotency-Key': `allocate-${randomUUID()}` },
      body: { warehouseId: warehouse.id }
    })
  ]);
  const statuses = [first.res.status, second.res.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409], `unexpected statuses: ${statuses.join(', ')}`);

  const finalReservation = await fetchReservation(token, reservation.id, warehouse.id);
  assert.equal(finalReservation.status, 'ALLOCATED');

  const transitions = await fetchTransitionEvents(db, tenantId, reservation.id);
  assert.equal(transitions.allocatedEvents, 1, `allocated transition should occur once, got ${transitions.allocatedEvents}`);
  assert.equal(transitions.cancelledEvents, 0);

  const balance = await fetchBalance(db, tenantId, itemId, sellable.id, 'each');
  assert.ok(nearlyEqual(balance.reserved, 0), `reserved expected 0, got ${balance.reserved}`);
  assert.ok(nearlyEqual(balance.allocated, 3), `allocated expected 3, got ${balance.allocated}`);
});

test('fulfill concurrent partial requests keep fulfilled quantity monotonic and bounded', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:fulfill-monotonic` });
  const sellable = defaults.SELLABLE;
  const itemId = await createItem(token, sellable.id, 'FULM');
  await seedStock(token, itemId, sellable.id, 12);

  const reservation = await createReservation(token, {
    warehouseId: warehouse.id,
    locationId: sellable.id,
    itemId,
    quantityReserved: 5
  });

  const allocateRes = await apiRequest('POST', `/reservations/${reservation.id}/allocate`, {
    token,
    headers: { 'Idempotency-Key': `allocate-${randomUUID()}` },
    body: { warehouseId: warehouse.id }
  });
  assert.equal(allocateRes.res.status, 200, JSON.stringify(allocateRes.payload));

  const fulfillA = apiRequest('POST', `/reservations/${reservation.id}/fulfill`, {
    token,
    headers: { 'Idempotency-Key': `fulfill-${randomUUID()}` },
    body: { warehouseId: warehouse.id, quantity: 3 }
  });
  const fulfillB = apiRequest('POST', `/reservations/${reservation.id}/fulfill`, {
    token,
    headers: { 'Idempotency-Key': `fulfill-${randomUUID()}` },
    body: { warehouseId: warehouse.id, quantity: 4 }
  });
  const [respA, respB] = await Promise.all([fulfillA, fulfillB]);
  const allowedStatuses = new Set([200, 409]);
  assert.ok(allowedStatuses.has(respA.res.status), `unexpected fulfillA status: ${respA.res.status}`);
  assert.ok(allowedStatuses.has(respB.res.status), `unexpected fulfillB status: ${respB.res.status}`);
  assert.ok(respA.res.status === 200 || respB.res.status === 200, 'expected at least one fulfill to succeed');

  const finalReservation = await fetchReservation(token, reservation.id, warehouse.id);
  const reservedQty = Number(finalReservation.quantityReserved);
  const fulfilledQty = Number(finalReservation.quantityFulfilled);
  assert.ok(fulfilledQty >= -1e-6, `fulfilled qty must be non-negative, got ${fulfilledQty}`);
  assert.ok(fulfilledQty <= reservedQty + 1e-6, `fulfilled qty exceeded reserved qty: ${fulfilledQty} > ${reservedQty}`);
  if (nearlyEqual(fulfilledQty, reservedQty)) {
    assert.equal(finalReservation.status, 'FULFILLED');
  } else {
    assert.equal(finalReservation.status, 'ALLOCATED');
  }

  const transitions = await fetchTransitionEvents(db, tenantId, reservation.id);
  assert.ok(
    nearlyEqual(transitions.fulfilledDelta, fulfilledQty),
    `fulfilled event delta ${transitions.fulfilledDelta} != quantity_fulfilled ${fulfilledQty}`
  );

  const balance = await fetchBalance(db, tenantId, itemId, sellable.id, 'each');
  assert.ok(nearlyEqual(balance.reserved, 0), `reserved expected 0, got ${balance.reserved}`);
  assert.ok(
    nearlyEqual(balance.allocated, Math.max(0, reservedQty - fulfilledQty)),
    `allocated mismatch, expected ${Math.max(0, reservedQty - fulfilledQty)} got ${balance.allocated}`
  );
});

test('cancel vs shipment post race does not deadlock and keeps reservation/balance consistent', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({
    token,
    apiRequest,
    scope: `${import.meta.url}:cancel-shipment-race`
  });
  const sellable = defaults.SELLABLE;
  const itemId = await createItem(token, sellable.id, 'CSHR');
  await seedStock(token, itemId, sellable.id, 10);
  const customerId = await createCustomer(tenantId, db);
  const order = await createSalesOrder(token, {
    customerId,
    itemId,
    quantityOrdered: 4,
    shipFromLocationId: sellable.id,
    warehouseId: warehouse.id
  });
  const lineId = order.lines[0]?.id;
  assert.ok(lineId, 'sales order line id missing');

  const reservation = await createReservationForDemand(token, {
    warehouseId: warehouse.id,
    locationId: sellable.id,
    itemId,
    quantityReserved: 4,
    demandId: lineId
  });

  const allocateRes = await apiRequest('POST', `/reservations/${reservation.id}/allocate`, {
    token,
    headers: { 'Idempotency-Key': `allocate-${randomUUID()}` },
    body: { warehouseId: warehouse.id }
  });
  assert.equal(allocateRes.res.status, 200, JSON.stringify(allocateRes.payload));

  const shipment = await createShipment(token, {
    salesOrderId: order.id,
    salesOrderLineId: lineId,
    shipFromLocationId: sellable.id,
    quantityShipped: 4
  });

  const cancelPromise = timedRequest(
    apiRequest('POST', `/reservations/${reservation.id}/cancel`, {
      token,
      headers: { 'Idempotency-Key': `cancel-${randomUUID()}` },
      body: { warehouseId: warehouse.id, reason: 'cancel-vs-shipment-race' }
    }),
    'CANCEL'
  );
  const postPromise = timedRequest(
    apiRequest('POST', `/shipments/${shipment.id}/post`, {
      token,
      headers: { 'Idempotency-Key': `ship-${randomUUID()}` },
      body: {}
    }),
    'SHIPMENT_POST'
  );
  const [cancelRes, postRes] = await Promise.all([cancelPromise, postPromise]);

  assert.ok([200, 409].includes(cancelRes.res.status), `unexpected cancel status ${cancelRes.res.status}`);
  assert.ok([200, 409].includes(postRes.res.status), `unexpected shipment status ${postRes.res.status}`);
  assert.notEqual(cancelRes.res.status, 500, 'cancel should not fail with 500');
  assert.notEqual(postRes.res.status, 500, 'shipment post should not fail with 500');

  const finalReservation = await fetchReservation(token, reservation.id, warehouse.id);
  const reservedQty = Number(finalReservation.quantityReserved);
  const fulfilledQty = Number(finalReservation.quantityFulfilled ?? 0);
  if (!['RESERVED', 'ALLOCATED', 'CANCELLED', 'FULFILLED'].includes(finalReservation.status)) {
    assert.fail(`unexpected final reservation status ${finalReservation.status}`);
  }
  const remainingOpenByStatus =
    finalReservation.status === 'RESERVED' || finalReservation.status === 'ALLOCATED'
      ? Math.max(0, reservedQty - fulfilledQty)
      : 0;

  const balance = await fetchBalance(db, tenantId, itemId, sellable.id, 'each');
  assert.ok(nearlyEqual(balance.reserved, 0), `reserved expected 0, got ${balance.reserved}`);
  assert.ok(
    nearlyEqual(balance.allocated, remainingOpenByStatus),
    `allocated mismatch: expected ${remainingOpenByStatus}, got ${balance.allocated}`
  );
});

test('shipment allows reservation-consumption allowance when available + reserveConsume meets ship qty', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({
    token,
    apiRequest,
    scope: `${import.meta.url}:reserve-consume-allow`
  });
  const sellable = defaults.SELLABLE;
  const itemId = await createItem(token, sellable.id, 'RSVALLOW');
  await seedStock(token, itemId, sellable.id, 10);
  const customerId = await createCustomer(tenantId, db);
  const order = await createSalesOrder(token, {
    customerId,
    itemId,
    quantityOrdered: 5,
    shipFromLocationId: sellable.id,
    warehouseId: warehouse.id
  });
  const lineId = order.lines[0]?.id;
  assert.ok(lineId, 'sales order line id missing');

  await createReservationForDemand(token, {
    warehouseId: warehouse.id,
    locationId: sellable.id,
    itemId,
    quantityReserved: 5,
    demandId: lineId
  });

  const shipment = await createShipment(token, {
    salesOrderId: order.id,
    salesOrderLineId: lineId,
    shipFromLocationId: sellable.id,
    quantityShipped: 5
  });

  const postRes = await apiRequest('POST', `/shipments/${shipment.id}/post`, {
    token,
    headers: { 'Idempotency-Key': `ship-${randomUUID()}` },
    body: {}
  });
  assert.equal(postRes.res.status, 200, JSON.stringify(postRes.payload));
});

test('shipment blocks when ship qty exceeds available + reserveConsume allowance', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({
    token,
    apiRequest,
    scope: `${import.meta.url}:reserve-consume-block`
  });
  const sellable = defaults.SELLABLE;
  const itemId = await createItem(token, sellable.id, 'RSVBLOCK');
  await seedStock(token, itemId, sellable.id, 10);
  const customerId = await createCustomer(tenantId, db);
  const order = await createSalesOrder(token, {
    customerId,
    itemId,
    quantityOrdered: 11,
    shipFromLocationId: sellable.id,
    warehouseId: warehouse.id
  });
  const lineId = order.lines[0]?.id;
  assert.ok(lineId, 'sales order line id missing');

  await createReservationForDemand(token, {
    warehouseId: warehouse.id,
    locationId: sellable.id,
    itemId,
    quantityReserved: 5,
    demandId: lineId
  });

  const shipment = await createShipment(token, {
    salesOrderId: order.id,
    salesOrderLineId: lineId,
    shipFromLocationId: sellable.id,
    quantityShipped: 11
  });

  const postRes = await apiRequest('POST', `/shipments/${shipment.id}/post`, {
    token,
    headers: { 'Idempotency-Key': `ship-${randomUUID()}` },
    body: {}
  });
  assert.equal(postRes.res.status, 409, JSON.stringify(postRes.payload));
  assert.equal(postRes.payload?.error?.code, 'INSUFFICIENT_AVAILABLE_WITH_ALLOWANCE');
  assert.equal(typeof postRes.payload?.error?.message, 'string');
  assert.ok(
    postRes.payload?.error?.details === undefined
      || (typeof postRes.payload?.error?.details === 'object' && postRes.payload?.error?.details !== null),
    'error.details must be object or undefined'
  );
});

test('three-way fulfill/cancel race preserves reservation and balance invariants', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({
    token,
    apiRequest,
    scope: `${import.meta.url}:three-way-race`
  });
  const sellable = defaults.SELLABLE;
  const itemId = await createItem(token, sellable.id, 'RACE3');
  await seedStock(token, itemId, sellable.id, 10);

  const reservation = await createReservation(token, {
    warehouseId: warehouse.id,
    locationId: sellable.id,
    itemId,
    quantityReserved: 5
  });

  const allocateRes = await apiRequest('POST', `/reservations/${reservation.id}/allocate`, {
    token,
    headers: { 'Idempotency-Key': `allocate-${randomUUID()}` },
    body: { warehouseId: warehouse.id }
  });
  assert.equal(allocateRes.res.status, 200, JSON.stringify(allocateRes.payload));
  assert.equal(allocateRes.payload.status, 'ALLOCATED');

  const outcomes = await Promise.allSettled([
    timedRequest(
      apiRequest('POST', `/reservations/${reservation.id}/fulfill`, {
        token,
        headers: { 'Idempotency-Key': `fulfill-${randomUUID()}` },
        body: { warehouseId: warehouse.id, quantity: 2 }
      }),
      'FULFILL_TWO'
    ),
    timedRequest(
      apiRequest('POST', `/reservations/${reservation.id}/cancel`, {
        token,
        headers: { 'Idempotency-Key': `cancel-${randomUUID()}` },
        body: { warehouseId: warehouse.id, reason: 'three-way-race' }
      }),
      'CANCEL'
    ),
    timedRequest(
      apiRequest('POST', `/reservations/${reservation.id}/fulfill`, {
        token,
        headers: { 'Idempotency-Key': `fulfill-${randomUUID()}` },
        body: { warehouseId: warehouse.id, quantity: 4 }
      }),
      'FULFILL_FOUR'
    )
  ]);

  for (const [idx, outcome] of outcomes.entries()) {
    if (outcome.status !== 'fulfilled') {
      assert.fail(`race request ${idx} rejected: ${outcome.reason?.message ?? String(outcome.reason)}`);
    }
    const status = outcome.value.res.status;
    assert.ok([200, 400, 409].includes(status), `unexpected race status ${status}`);
    if (status === 400) {
      assert.equal(
        outcome.value.payload?.error?.code,
        'RESERVATION_INVALID_QUANTITY',
        `unexpected 400 payload: ${JSON.stringify(outcome.value.payload)}`
      );
    }
    if (status === 409) {
      const message = String(outcome.value.payload?.error ?? '');
      assert.ok(
        message.toLowerCase().includes('current state'),
        `unexpected 409 payload: ${JSON.stringify(outcome.value.payload)}`
      );
    }
  }

  const reservationRes = await db.query(
    `SELECT status, quantity_reserved, COALESCE(quantity_fulfilled, 0) AS quantity_fulfilled
       FROM inventory_reservations
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND id = $3`,
    [tenantId, warehouse.id, reservation.id]
  );
  assert.equal(reservationRes.rowCount, 1);

  const status = reservationRes.rows[0].status;
  const quantityReserved = Number(reservationRes.rows[0].quantity_reserved);
  const quantityFulfilled = Number(reservationRes.rows[0].quantity_fulfilled);
  const openQty = Math.max(0, quantityReserved - quantityFulfilled);

  assert.ok(quantityFulfilled >= -1e-6, `quantity_fulfilled must be >= 0, got ${quantityFulfilled}`);
  assert.ok(
    quantityFulfilled <= quantityReserved + 1e-6,
    `quantity_fulfilled exceeded quantity_reserved (${quantityFulfilled} > ${quantityReserved})`
  );
  assert.ok(['ALLOCATED', 'CANCELLED', 'FULFILLED'].includes(status), `unexpected status ${status}`);
  if (status === 'FULFILLED') {
    assert.ok(nearlyEqual(quantityFulfilled, quantityReserved), 'FULFILLED requires quantity_fulfilled == quantity_reserved');
  }
  if (status === 'ALLOCATED') {
    assert.ok(openQty > 1e-6, `ALLOCATED must have open quantity, got ${openQty}`);
  }
  if (status === 'CANCELLED') {
    assert.ok(quantityFulfilled <= quantityReserved + 1e-6);
  }

  const commitments = await fetchOpenCommitments(db, tenantId, warehouse.id, itemId, sellable.id, 'each');
  const balance = await fetchBalance(db, tenantId, itemId, sellable.id, 'each');
  assert.ok(nearlyEqual(balance.reserved, commitments.reservedOpen));
  assert.ok(nearlyEqual(balance.allocated, commitments.allocatedOpen));
  assert.ok(balance.onHand >= -1e-6, `on_hand must be non-negative, got ${balance.onHand}`);
  assert.ok(balance.reserved >= -1e-6, `reserved must be non-negative, got ${balance.reserved}`);
  assert.ok(balance.allocated >= -1e-6, `allocated must be non-negative, got ${balance.allocated}`);
});
