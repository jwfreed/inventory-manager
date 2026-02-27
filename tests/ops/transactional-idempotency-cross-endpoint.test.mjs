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

async function createItem(token, defaultLocationId) {
  const sku = `IDEMP-XEP-${randomUUID().slice(0, 8)}`;
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

async function createApprovedPurchaseOrder(token, vendorId, itemId, locationId, quantity, unitCost) {
  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId: locationId,
      receivingLocationId: locationId,
      expectedDate: '2026-02-10',
      status: 'approved',
      lines: [{ itemId, uom: 'each', quantityOrdered: quantity, unitCost, currencyCode: 'THB' }]
    }
  });
  assert.equal(poRes.res.status, 201, JSON.stringify(poRes.payload));
  return poRes.payload;
}

async function snapshotMutationCounts(db, tenantId, idempotencyKey) {
  const [movementsRes, linesRes, layersRes, transferExecRes] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS count
         FROM inventory_movements
        WHERE tenant_id = $1`,
      [tenantId]
    ),
    db.query(
      `SELECT COUNT(*)::int AS count
         FROM inventory_movement_lines
        WHERE tenant_id = $1`,
      [tenantId]
    ),
    db.query(
      `SELECT COUNT(*)::int AS count
         FROM inventory_cost_layers
        WHERE tenant_id = $1`,
      [tenantId]
    ),
    db.query(
      `SELECT COUNT(*)::int AS count
         FROM transfer_post_executions
        WHERE tenant_id = $1
          AND idempotency_key = $2`,
      [tenantId, idempotencyKey]
    )
  ]);
  return {
    movements: Number(movementsRes.rows[0]?.count ?? 0),
    movementLines: Number(linesRes.rows[0]?.count ?? 0),
    costLayers: Number(layersRes.rows[0]?.count ?? 0),
    transferExecutionsForKey: Number(transferExecRes.rows[0]?.count ?? 0)
  };
}

test('transactional idempotency rejects same key across endpoints with no ledger writes', async () => {
  const tenantSlug = `tx-idem-cross-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Transactional Idempotency Cross Endpoint Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;

  const factory = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const store = await createWarehouseWithSellable(token, `STORE-${randomUUID().slice(0, 6)}`);
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, factory.defaults.SELLABLE.id);
  const po = await createApprovedPurchaseOrder(token, vendorId, itemId, factory.defaults.SELLABLE.id, 12, 4.2);

  const sharedIdempotencyKey = `idem-cross-endpoint-${randomUUID()}`;
  const receiptBody = {
    purchaseOrderId: po.id,
    receivedAt: '2026-02-11T00:00:00.000Z',
    lines: [
      {
        purchaseOrderLineId: po.lines[0].id,
        uom: 'each',
        quantityReceived: 12,
        unitCost: 4.2
      }
    ]
  };

  const first = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': sharedIdempotencyKey },
    body: receiptBody
  });
  assert.equal(first.res.status, 201, JSON.stringify(first.payload));

  const idempotencyBefore = await db.query(
    `SELECT endpoint, response_status, response_body::text AS response_body_text
       FROM idempotency_keys
      WHERE tenant_id = $1
        AND key = $2`,
    [tenantId, sharedIdempotencyKey]
  );
  assert.equal(idempotencyBefore.rowCount, 1);
  assert.equal(idempotencyBefore.rows[0]?.endpoint, '/purchase-order-receipts');

  const baselineCounts = await snapshotMutationCounts(db, tenantId, sharedIdempotencyKey);

  const crossEndpoint = await apiRequest('POST', '/inventory-transfers', {
    token,
    headers: { 'Idempotency-Key': sharedIdempotencyKey },
    body: {
      sourceLocationId: factory.defaults.SELLABLE.id,
      destinationLocationId: store.sellable.id,
      itemId,
      quantity: 1,
      uom: 'each',
      reasonCode: 'distribution',
      notes: 'cross-endpoint-idempotency'
    }
  });
  assert.equal(crossEndpoint.res.status, 409, JSON.stringify(crossEndpoint.payload));
  assert.equal(crossEndpoint.payload?.error?.code, 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS');

  const afterCounts = await snapshotMutationCounts(db, tenantId, sharedIdempotencyKey);
  assert.deepEqual(afterCounts, baselineCounts, 'rejected cross-endpoint call must not create ledger or transfer execution rows');

  const idempotencyAfter = await db.query(
    `SELECT endpoint, response_status, response_body::text AS response_body_text
       FROM idempotency_keys
      WHERE tenant_id = $1
        AND key = $2`,
    [tenantId, sharedIdempotencyKey]
  );
  assert.equal(idempotencyAfter.rowCount, 1);
  assert.equal(idempotencyAfter.rows[0]?.endpoint, idempotencyBefore.rows[0]?.endpoint);
  assert.equal(Number(idempotencyAfter.rows[0]?.response_status ?? 0), Number(idempotencyBefore.rows[0]?.response_status ?? 0));
  assert.equal(idempotencyAfter.rows[0]?.response_body_text, idempotencyBefore.rows[0]?.response_body_text);
});
