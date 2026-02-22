import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `transfer-idempotency-${randomUUID().slice(0, 8)}`;

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
    tenantName: 'Transfer Idempotency Tenant'
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

async function createItem(token, defaultLocationId) {
  const sku = `ITEM-${randomUUID().slice(0, 8)}`;
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
    headers: { 'Idempotency-Key': `transfer-idem-receipt-${randomUUID()}` },
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
    headers: { 'Idempotency-Key': `transfer-idem-qc-${randomUUID()}` },
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

test('inventory transfer idempotency: replay, conflict, incomplete detection', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const db = session.pool;
  const tenantId = session.tenant.id;
  const actorId = session.user?.id ?? null;

  const factory = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const store = await createWarehouseWithSellable(token, `STORE-${randomUUID().slice(0, 6)}`);
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, factory.defaults.SELLABLE.id);

  const receiptLineId = await createReceipt({
    token,
    vendorId,
    itemId,
    locationId: factory.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });
  await qcAccept(token, receiptLineId, 10, actorId);

  const payload = {
    sourceLocationId: factory.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId,
    quantity: 3,
    uom: 'each',
    reasonCode: 'distribution',
    notes: 'Transfer idempotency test'
  };
  const idempotencyKey = `transfer-idem-${randomUUID()}`;

  const first = await apiRequest('POST', '/inventory-transfers', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: payload
  });
  assert.equal(first.res.status, 201, JSON.stringify(first.payload));
  const firstMovementId = first.payload.movementId;
  assert.ok(firstMovementId);
  assert.equal(first.payload.transferId, firstMovementId);
  assert.equal(first.payload.transfer_id, firstMovementId);
  assert.equal(first.payload.idempotencyKey, idempotencyKey);
  assert.equal(first.payload.idempotency_key, idempotencyKey);
  assert.equal(first.payload.replayed, false);

  const replay = await apiRequest('POST', '/inventory-transfers', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: payload
  });
  assert.equal(replay.res.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.payload.movementId, firstMovementId);
  assert.equal(replay.payload.transferId, firstMovementId);
  assert.equal(replay.payload.transfer_id, firstMovementId);
  assert.equal(replay.payload.idempotencyKey, idempotencyKey);
  assert.equal(replay.payload.idempotency_key, idempotencyKey);
  assert.equal(replay.payload.replayed, true);

  const movementCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = 'inventory_transfer'
        AND source_id = $2`,
    [tenantId, `idempotency:${idempotencyKey}`]
  );
  assert.equal(Number(movementCount.rows[0]?.count ?? 0), 1);

  const mismatchWarehouse = await apiRequest('POST', '/inventory-transfers', {
    token,
    headers: { 'Idempotency-Key': `transfer-idem-mismatch-${randomUUID()}` },
    body: {
      ...payload,
      warehouseId: factory.warehouse.id
    }
  });
  assert.equal(mismatchWarehouse.res.status, 409, JSON.stringify(mismatchWarehouse.payload));
  assert.equal(mismatchWarehouse.payload?.error?.code, 'WAREHOUSE_SCOPE_MISMATCH');

  const conflict = await apiRequest('POST', '/inventory-transfers', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      ...payload,
      quantity: 4
    }
  });
  assert.equal(conflict.res.status, 409, JSON.stringify(conflict.payload));
  assert.equal(conflict.payload?.error?.code, 'INV_TRANSFER_IDEMPOTENCY_CONFLICT');

  const incompleteKey = `transfer-idem-incomplete-${randomUUID()}`;
  const incompleteFirst = await apiRequest('POST', '/inventory-transfers', {
    token,
    headers: { 'Idempotency-Key': incompleteKey },
    body: {
      ...payload,
      quantity: 1
    }
  });
  assert.ok([200, 201].includes(incompleteFirst.res.status), JSON.stringify(incompleteFirst.payload));

  await db.query(
    `UPDATE transfer_post_executions
        SET status = 'IN_PROGRESS',
            inventory_movement_id = NULL,
            updated_at = now()
      WHERE tenant_id = $1
        AND idempotency_key = $2`,
    [tenantId, incompleteKey]
  );

  const incompleteReplay = await apiRequest('POST', '/inventory-transfers', {
    token,
    headers: { 'Idempotency-Key': incompleteKey },
    body: {
      ...payload,
      quantity: 1
    }
  });
  assert.equal(incompleteReplay.res.status, 409, JSON.stringify(incompleteReplay.payload));
  assert.equal(incompleteReplay.payload?.error?.code, 'INV_TRANSFER_IDEMPOTENCY_INCOMPLETE');
});
