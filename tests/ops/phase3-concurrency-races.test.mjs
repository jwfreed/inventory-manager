import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `phase3-races-${randomUUID().slice(0, 8)}`;

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
  return ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Phase 3 Concurrency Races Tenant'
  });
}

async function createWarehouseWithSellable(token, codePrefix) {
  const warehouseRes = await apiRequest('POST', '/locations', {
    token,
    body: {
      code: `${codePrefix}-WH`,
      name: `${codePrefix} Warehouse`,
      type: 'warehouse',
      active: true
    }
  });
  assert.equal(warehouseRes.res.status, 201, JSON.stringify(warehouseRes.payload));

  const sellableRes = await apiRequest('POST', '/locations', {
    token,
    body: {
      code: `${codePrefix}-SELLABLE`,
      name: `${codePrefix} Sellable`,
      type: 'bin',
      role: 'SELLABLE',
      isSellable: true,
      active: true,
      parentLocationId: warehouseRes.payload.id
    }
  });
  assert.equal(sellableRes.res.status, 201, JSON.stringify(sellableRes.payload));

  return { warehouse: warehouseRes.payload, sellable: sellableRes.payload };
}

async function createVendor(token) {
  const code = `V-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/vendors', {
    token,
    body: { code, name: `Vendor ${code}` }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createItem(token, defaultLocationId, prefix = 'ITEM') {
  const sku = `${prefix}-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/items', {
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
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createReceipt({ token, vendorId, itemId, locationId, quantity, unitCost }) {
  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId: locationId,
      receivingLocationId: locationId,
      expectedDate: new Date().toISOString().slice(0, 10),
      status: 'approved',
      lines: [{ itemId, uom: 'each', quantityOrdered: quantity, unitCost, currencyCode: 'THB' }]
    }
  });
  assert.equal(poRes.res.status, 201, JSON.stringify(poRes.payload));

  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `race-receipt-${randomUUID()}` },
    body: {
      purchaseOrderId: poRes.payload.id,
      receivedAt: new Date().toISOString(),
      lines: [
        {
          purchaseOrderLineId: poRes.payload.lines[0].id,
          uom: 'each',
          quantityReceived: quantity,
          unitCost
        }
      ]
    }
  });
  assert.equal(receiptRes.res.status, 201, JSON.stringify(receiptRes.payload));
  return receiptRes.payload.lines[0].id;
}

async function qcAccept(token, receiptLineId, quantity, actorId) {
  const res = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': `race-qc-${randomUUID()}` },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity,
      uom: 'each',
      actorType: 'user',
      actorId
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
}

async function createCustomer(db, tenantId) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO customers (id, tenant_id, code, name, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, now(), now())`,
    [id, tenantId, `C-${id.slice(0, 8)}`, `Customer ${id.slice(0, 6)}`]
  );
  return id;
}

function assertRaceResult(result, allowedStatuses, allowedCodes) {
  assert.equal(result.status, 'fulfilled');
  const response = result.value;
  assert.ok(allowedStatuses.has(response.res.status), `status=${response.res.status} body=${JSON.stringify(response.payload)}`);
  if (response.res.status === 409 && allowedCodes.size > 0) {
    const code = response.payload?.error?.code ?? null;
    if (code !== null) {
      assert.ok(allowedCodes.has(code), `code=${code} body=${JSON.stringify(response.payload)}`);
    }
  }
}

test('cycle count post vs fulfillment race remains deterministic and drift-safe', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const db = session.pool;
  const tenantId = session.tenant.id;
  const actorId = session.user?.id ?? null;

  const store = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, store.defaults.SELLABLE.id, 'RACE-CYCLE');
  const receiptLineId = await createReceipt({
    token,
    vendorId,
    itemId,
    locationId: store.defaults.SELLABLE.id,
    quantity: 6,
    unitCost: 4
  });
  await qcAccept(token, receiptLineId, 6, actorId);

  const customerId = await createCustomer(db, tenantId);
  const soRes = await apiRequest('POST', '/sales-orders', {
    token,
    body: {
      soNumber: `SO-${randomUUID().slice(0, 8)}`,
      customerId,
      status: 'submitted',
      warehouseId: store.warehouse.id,
      shipFromLocationId: store.defaults.SELLABLE.id,
      lines: [{ itemId, uom: 'each', quantityOrdered: 5 }]
    }
  });
  assert.equal(soRes.res.status, 201, JSON.stringify(soRes.payload));
  const soLineId = soRes.payload.lines[0].id;

  const reserveRes = await apiRequest('POST', '/reservations', {
    token,
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: soLineId,
          itemId,
          warehouseId: store.warehouse.id,
          locationId: store.defaults.SELLABLE.id,
          uom: 'each',
          quantityReserved: 5
        }
      ]
    }
  });
  assert.equal(reserveRes.res.status, 201, JSON.stringify(reserveRes.payload));

  const shipmentRes = await apiRequest('POST', '/shipments', {
    token,
    body: {
      salesOrderId: soRes.payload.id,
      shippedAt: new Date().toISOString(),
      shipFromLocationId: store.defaults.SELLABLE.id,
      lines: [{ salesOrderLineId: soLineId, uom: 'each', quantityShipped: 5 }]
    }
  });
  assert.equal(shipmentRes.res.status, 201, JSON.stringify(shipmentRes.payload));

  const countRes = await apiRequest('POST', '/inventory-counts', {
    token,
    body: {
      countedAt: new Date().toISOString(),
      warehouseId: store.warehouse.id,
      locationId: store.defaults.SELLABLE.id,
      lines: [
        {
          lineNumber: 1,
          itemId,
          locationId: store.defaults.SELLABLE.id,
          uom: 'each',
          countedQuantity: 1,
          reasonCode: 'cycle_race'
        }
      ]
    }
  });
  assert.equal(countRes.res.status, 201, JSON.stringify(countRes.payload));

  const [countPost, shipmentPost] = await Promise.allSettled([
    apiRequest('POST', `/inventory-counts/${countRes.payload.id}/post`, {
      token,
      headers: { 'Idempotency-Key': `race-count-post-${randomUUID()}` },
      body: {}
    }),
    apiRequest('POST', `/shipments/${shipmentRes.payload.id}/post`, {
      token,
      headers: { 'Idempotency-Key': `race-shipment-post-${randomUUID()}` },
      body: {}
    })
  ]);

  assertRaceResult(
    countPost,
    new Set([200, 409]),
    new Set(['CYCLE_COUNT_RECONCILIATION_FAILED', 'INSUFFICIENT_STOCK', 'TX_RETRY_EXHAUSTED'])
  );
  assertRaceResult(
    shipmentPost,
    new Set([200, 409]),
    new Set(['INSUFFICIENT_AVAILABLE_WITH_ALLOWANCE', 'INSUFFICIENT_STOCK', 'TX_RETRY_EXHAUSTED'])
  );

  const snapshot = await db.query(
    `SELECT on_hand_qty
       FROM inventory_available_location_v
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND location_id = $3
        AND item_id = $4
        AND uom = 'each'
      LIMIT 1`,
    [tenantId, store.warehouse.id, store.defaults.SELLABLE.id, itemId]
  );
  const onHand = Number(snapshot.rows[0]?.on_hand_qty ?? 0);
  assert.ok(Math.abs(onHand - 1) <= 1e-6, `on_hand=${onHand}`);

  const nonNegative = await db.query(
    `SELECT on_hand, reserved, allocated
       FROM inventory_balance
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = 'each'
      LIMIT 1`,
    [tenantId, itemId, store.defaults.SELLABLE.id]
  );
  assert.ok(nonNegative.rowCount > 0);
  assert.ok(Number(nonNegative.rows[0].on_hand) >= -1e-6);
  assert.ok(Number(nonNegative.rows[0].reserved) >= -1e-6);
  assert.ok(Number(nonNegative.rows[0].allocated) >= -1e-6);
});

test('transfer arrival vs reservation creation race is deterministic and warehouse scoped', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const db = session.pool;
  const tenantId = session.tenant.id;
  const actorId = session.user?.id ?? null;

  const factory = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:factory` });
  const store = await createWarehouseWithSellable(token, `STORE-${randomUUID().slice(0, 6)}`);
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, factory.defaults.SELLABLE.id, 'RACE-TRANSFER');
  const receiptLineId = await createReceipt({
    token,
    vendorId,
    itemId,
    locationId: factory.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 6
  });
  await qcAccept(token, receiptLineId, 5, actorId);

  const customerId = await createCustomer(db, tenantId);
  const soRes = await apiRequest('POST', '/sales-orders', {
    token,
    body: {
      soNumber: `SO-${randomUUID().slice(0, 8)}`,
      customerId,
      status: 'submitted',
      warehouseId: store.warehouse.id,
      shipFromLocationId: store.sellable.id,
      lines: [{ itemId, uom: 'each', quantityOrdered: 5 }]
    }
  });
  assert.equal(soRes.res.status, 201, JSON.stringify(soRes.payload));
  const soLineId = soRes.payload.lines[0].id;

  const [transferResult, reserveResult] = await Promise.allSettled([
    apiRequest('POST', '/inventory-transfers', {
      token,
      headers: { 'Idempotency-Key': `race-transfer-${randomUUID()}` },
      body: {
        sourceLocationId: factory.defaults.SELLABLE.id,
        destinationLocationId: store.sellable.id,
        itemId,
        quantity: 5,
        uom: 'each',
        reasonCode: 'distribution_race'
      }
    }),
    apiRequest('POST', '/reservations', {
      token,
      headers: { 'Idempotency-Key': `race-reserve-${randomUUID()}` },
      body: {
        reservations: [
          {
            demandType: 'sales_order_line',
            demandId: soLineId,
            itemId,
            warehouseId: store.warehouse.id,
            locationId: store.sellable.id,
            uom: 'each',
            quantityReserved: 5
          }
        ]
      }
    })
  ]);

  assert.equal(transferResult.status, 'fulfilled');
  assert.ok([200, 201].includes(transferResult.value.res.status), JSON.stringify(transferResult.value.payload));

  assert.equal(reserveResult.status, 'fulfilled');
  assert.ok([201, 409].includes(reserveResult.value.res.status), JSON.stringify(reserveResult.value.payload));

  const reservationRows = await db.query(
    `SELECT r.id, r.quantity_reserved, r.warehouse_id, r.location_id, l.warehouse_id AS location_warehouse_id
       FROM inventory_reservations r
       JOIN locations l
         ON l.id = r.location_id
        AND l.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1
        AND r.demand_type = 'sales_order_line'
        AND r.demand_id = $2`,
    [tenantId, soLineId]
  );

  for (const row of reservationRows.rows) {
    assert.equal(row.warehouse_id, store.warehouse.id);
    assert.equal(row.location_warehouse_id, store.warehouse.id);
    assert.ok(Number(row.quantity_reserved) <= 5 + 1e-6);
  }

  const crossWarehouseReservations = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_reservations
      WHERE tenant_id = $1
        AND demand_type = 'sales_order_line'
        AND demand_id = $2
        AND warehouse_id = $3`,
    [tenantId, soLineId, factory.warehouse.id]
  );
  assert.equal(Number(crossWarehouseReservations.rows[0]?.count ?? 0), 0);
});
