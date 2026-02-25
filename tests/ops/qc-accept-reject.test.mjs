import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';

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

async function createVendor(token) {
  const code = `V-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/vendors', {
    token,
    body: { code, name: `Vendor ${code}` }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createItem(token, defaultLocationId, skuPrefix) {
  const sku = `${skuPrefix}-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      type: 'finished',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId,
      active: true
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function postReceiptToQa({ token, vendorId, itemId, qaLocationId, quantity, unitCost, key }) {
  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId: qaLocationId,
      receivingLocationId: qaLocationId,
      expectedDate: '2026-03-01',
      status: 'approved',
      lines: [{ itemId, uom: 'each', quantityOrdered: quantity, unitCost, currencyCode: 'THB' }]
    }
  });
  assert.equal(poRes.res.status, 201, JSON.stringify(poRes.payload));

  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': key },
    body: {
      purchaseOrderId: poRes.payload.id,
      receivedAt: '2026-03-02T00:00:00.000Z',
      receivedToLocationId: qaLocationId,
      idempotencyKey: key,
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
}

async function readBalanceByLocation(pool, tenantId, itemId, locationId) {
  const res = await pool.query(
    `SELECT COALESCE(on_hand, 0)::numeric AS on_hand
       FROM inventory_balance
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3`,
    [tenantId, itemId, locationId]
  );
  return Number(res.rows[0]?.on_hand ?? 0);
}

function toAvailableToPromise(row) {
  if (!row || typeof row !== 'object') return 0;
  const preferred = row.availableToPromise ?? row.available_to_promise ?? row.availableQty ?? row.available_qty;
  if (preferred !== undefined && preferred !== null) return Number(preferred);
  const onHand = Number(row.onHand ?? row.on_hand ?? 0);
  const reserved = Number(row.reserved ?? row.reserved_qty ?? 0);
  const allocated = Number(row.allocated ?? row.allocated_qty ?? 0);
  return onHand - reserved - allocated;
}

test('qc accept/reject wrappers move stock QA->SELLABLE and QA->HOLD with idempotent replay', { timeout: 180000 }, async () => {
  const tenantSlug = `qc-wrapper-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'QC Wrapper Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  assert.ok(token);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, defaults.QA.id, 'QCWRAP');

  await postReceiptToQa({
    token,
    vendorId,
    itemId,
    qaLocationId: defaults.QA.id,
    quantity: 30,
    unitCost: 12,
    key: `qc-wrapper-receipt:${tenantSlug}`
  });

  const acceptKey = `qc-accept:${tenantSlug}`;
  const acceptFirst = await apiRequest('POST', '/qc/accept', {
    token,
    headers: { 'Idempotency-Key': acceptKey },
    body: {
      warehouseId: warehouse.id,
      itemId,
      quantity: 10,
      uom: 'each',
      idempotencyKey: acceptKey
    }
  });
  assert.equal(acceptFirst.res.status, 201, JSON.stringify(acceptFirst.payload));
  assert.equal(acceptFirst.payload.action, 'accept');
  assert.equal(acceptFirst.payload.replayed, false);

  const acceptReplay = await apiRequest('POST', '/qc/accept', {
    token,
    headers: { 'Idempotency-Key': acceptKey },
    body: {
      warehouseId: warehouse.id,
      itemId,
      quantity: 10,
      uom: 'each',
      idempotencyKey: acceptKey
    }
  });
  assert.equal(acceptReplay.res.status, 200, JSON.stringify(acceptReplay.payload));
  assert.equal(acceptReplay.payload.replayed, true);
  assert.equal(acceptReplay.payload.movementId, acceptFirst.payload.movementId);

  const rejectKey = `qc-reject:${tenantSlug}`;
  const rejectRes = await apiRequest('POST', '/qc/reject', {
    token,
    headers: { 'Idempotency-Key': rejectKey },
    body: {
      warehouseId: warehouse.id,
      itemId,
      quantity: 8,
      uom: 'each',
      idempotencyKey: rejectKey
    }
  });
  assert.equal(rejectRes.res.status, 201, JSON.stringify(rejectRes.payload));
  assert.equal(rejectRes.payload.action, 'reject');

  const qaOnHand = await readBalanceByLocation(db, tenantId, itemId, defaults.QA.id);
  const sellableOnHand = await readBalanceByLocation(db, tenantId, itemId, defaults.SELLABLE.id);
  const holdOnHand = await readBalanceByLocation(db, tenantId, itemId, defaults.HOLD.id);
  assert.ok(Math.abs(qaOnHand - 12) < 1e-6, `qaOnHand=${qaOnHand}`);
  assert.ok(Math.abs(sellableOnHand - 10) < 1e-6, `sellableOnHand=${sellableOnHand}`);
  assert.ok(Math.abs(holdOnHand - 8) < 1e-6, `holdOnHand=${holdOnHand}`);

  const atpRes = await apiRequest('GET', '/atp', {
    token,
    params: { warehouseId: warehouse.id, itemId }
  });
  assert.equal(atpRes.res.status, 200, JSON.stringify(atpRes.payload));
  const atpRows = atpRes.payload?.data ?? [];
  const holdAtpRow = atpRows.find((row) => row.locationId === defaults.HOLD.id);
  if (holdAtpRow) {
    assert.ok(
      Math.abs(toAvailableToPromise(holdAtpRow)) < 1e-6,
      `HOLD ATP must be excluded; holdRow=${JSON.stringify(holdAtpRow)}`
    );
  }
  const totalAvailable = atpRows.reduce((sum, row) => sum + toAvailableToPromise(row), 0);
  assert.ok(Math.abs(totalAvailable - 10) < 1e-6, `expected ATP 10 from SELLABLE only; totalAvailable=${totalAvailable}`);

  const movementWarehouseCheck = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movement_lines iml
       JOIN inventory_movements im
         ON im.id = iml.movement_id
        AND im.tenant_id = iml.tenant_id
       JOIN locations l
         ON l.id = iml.location_id
        AND l.tenant_id = iml.tenant_id
      WHERE iml.tenant_id = $1
        AND im.id = ANY($2::uuid[])
        AND l.warehouse_id <> $3::uuid`,
    [tenantId, [acceptFirst.payload.movementId, rejectRes.payload.movementId], warehouse.id]
  );
  assert.equal(Number(movementWarehouseCheck.rows[0].count), 0);
});
