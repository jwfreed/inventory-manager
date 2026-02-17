import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import { stopTestServer } from '../api/helpers/testServer.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `receipt-void-${randomUUID().slice(0, 8)}`;
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
  const payload = contentType.includes('application/json')
    ? await res.json().catch(() => null)
    : await res.text().catch(() => '');
  return { res, payload };
}

async function getSession() {
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Receipt Void Reversal Tenant'
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
        // Ignore teardown failures.
      }
    })
  );
  openPools.clear();
  await stopTestServer();
});

async function createPostedReceipt({ token, quantity, shipToLocationId, receivedToLocationId }) {
  const vendorCode = `V-${Date.now()}-${randomUUID().slice(0, 4)}`;
  const vendorRes = await apiRequest('POST', '/vendors', {
    token,
    body: { code: vendorCode, name: `Vendor ${vendorCode}` }
  });
  assert.equal(vendorRes.res.status, 201, JSON.stringify(vendorRes.payload));
  const vendorId = vendorRes.payload.id;

  const sku = `RV-${randomUUID().slice(0, 8)}`;
  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: shipToLocationId
    }
  });
  assert.equal(itemRes.res.status, 201, JSON.stringify(itemRes.payload));
  const itemId = itemRes.payload.id;

  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId,
      receivingLocationId: shipToLocationId,
      expectedDate: new Date().toISOString().slice(0, 10),
      status: 'approved',
      lines: [
        {
          itemId,
          uom: 'each',
          quantityOrdered: quantity,
          unitCost: 5,
          currencyCode: 'THB'
        }
      ]
    }
  });
  assert.equal(poRes.res.status, 201, JSON.stringify(poRes.payload));

  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `receipt-${randomUUID()}` },
    body: {
      purchaseOrderId: poRes.payload.id,
      receivedAt: new Date().toISOString(),
      receivedToLocationId,
      lines: [
        {
          purchaseOrderLineId: poRes.payload.lines[0].id,
          uom: 'each',
          quantityReceived: quantity,
          unitCost: 5
        }
      ]
    }
  });
  assert.equal(receiptRes.res.status, 201, JSON.stringify(receiptRes.payload));

  return {
    itemId,
    receiptId: receiptRes.payload.id,
    movementId: receiptRes.payload.inventoryMovementId,
    quantity
  };
}

async function ledgerOnHandAtLocation(db, tenantId, itemId, locationId, uom = 'each') {
  const result = await db.query(
    `SELECT COALESCE(SUM(COALESCE(iml.quantity_delta_canonical, iml.quantity_delta)), 0) AS on_hand
       FROM inventory_movement_lines iml
       JOIN inventory_movements im
         ON im.id = iml.movement_id
        AND im.tenant_id = iml.tenant_id
      WHERE iml.tenant_id = $1
        AND iml.item_id = $2
        AND iml.location_id = $3
        AND COALESCE(iml.canonical_uom, iml.uom) = $4
        AND im.status = 'posted'`,
    [tenantId, itemId, locationId, uom]
  );
  return Number(result.rows[0]?.on_hand ?? 0);
}

async function getBalanceOnHand(db, tenantId, itemId, locationId, uom = 'each') {
  const result = await db.query(
    `SELECT on_hand
       FROM inventory_balance
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = $4`,
    [tenantId, itemId, locationId, uom]
  );
  return result.rowCount ? Number(result.rows[0].on_hand) : 0;
}

test('voiding a receipt posts an exact reversal and remains idempotent under concurrency', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:void` });
  const qaLocationId = defaults.QA.id;
  const sellableLocationId = defaults.SELLABLE.id;

  const receipt = await createPostedReceipt({
    token,
    quantity: 5,
    shipToLocationId: sellableLocationId,
    receivedToLocationId: qaLocationId
  });

  const preVoidLedger = await ledgerOnHandAtLocation(db, tenantId, receipt.itemId, qaLocationId, 'each');
  assert.ok(Math.abs(preVoidLedger - 5) < 1e-6, `Expected pre-void ledger on-hand 5, got ${preVoidLedger}`);

  const voidKey = `void-${randomUUID()}`;
  const voidRes = await apiRequest('POST', `/purchase-order-receipts/${receipt.receiptId}/void`, {
    token,
    headers: { 'Idempotency-Key': voidKey },
    body: { reason: 'supplier cancellation' }
  });
  assert.equal(voidRes.res.status, 200, JSON.stringify(voidRes.payload));
  assert.equal(voidRes.payload.status, 'voided');

  const reversalMovementResult = await db.query(
    `SELECT id, movement_type, status
       FROM inventory_movements
      WHERE tenant_id = $1
        AND reversal_of_movement_id = $2`,
    [tenantId, receipt.movementId]
  );
  assert.equal(reversalMovementResult.rowCount, 1);
  assert.equal(reversalMovementResult.rows[0].movement_type, 'receipt_reversal');
  assert.equal(reversalMovementResult.rows[0].status, 'posted');
  const reversalMovementId = reversalMovementResult.rows[0].id;

  const originalLinesResult = await db.query(
    `SELECT item_id,
            location_id,
            uom,
            canonical_uom,
            quantity_delta,
            quantity_delta_canonical,
            extended_cost
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
      ORDER BY item_id, location_id, uom, canonical_uom`,
    [tenantId, receipt.movementId]
  );
  const reversalLinesResult = await db.query(
    `SELECT item_id,
            location_id,
            uom,
            canonical_uom,
            quantity_delta,
            quantity_delta_canonical,
            extended_cost
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
      ORDER BY item_id, location_id, uom, canonical_uom`,
    [tenantId, reversalMovementId]
  );
  assert.equal(reversalLinesResult.rowCount, originalLinesResult.rowCount);
  const reversalByKey = new Map();
  for (const row of reversalLinesResult.rows) {
    const key = `${row.item_id}|${row.location_id}|${row.uom}|${row.canonical_uom ?? ''}`;
    const list = reversalByKey.get(key) ?? [];
    list.push(row);
    reversalByKey.set(key, list);
  }
  for (const original of originalLinesResult.rows) {
    const key = `${original.item_id}|${original.location_id}|${original.uom}|${original.canonical_uom ?? ''}`;
    const candidates = reversalByKey.get(key) ?? [];
    assert.ok(candidates.length > 0, `Missing reversal line for key ${key}`);
    const reversal = candidates.pop();
    reversalByKey.set(key, candidates);

    assert.ok(Math.abs(Number(reversal.quantity_delta) + Number(original.quantity_delta)) < 1e-6);

    if (original.quantity_delta_canonical === null) {
      assert.equal(reversal.quantity_delta_canonical, null);
    } else {
      assert.notEqual(reversal.quantity_delta_canonical, null);
      assert.ok(
        Math.abs(Number(reversal.quantity_delta_canonical) + Number(original.quantity_delta_canonical)) < 1e-6
      );
    }

    if (original.extended_cost === null) {
      assert.equal(reversal.extended_cost, null);
    } else {
      assert.notEqual(reversal.extended_cost, null);
      assert.ok(Math.abs(Number(reversal.extended_cost) + Number(original.extended_cost)) < 1e-6);
    }
  }

  const postVoidLedger = await ledgerOnHandAtLocation(db, tenantId, receipt.itemId, qaLocationId, 'each');
  assert.ok(Math.abs(postVoidLedger) < 1e-6, `Expected post-void ledger on-hand 0, got ${postVoidLedger}`);
  const postVoidBalance = await getBalanceOnHand(db, tenantId, receipt.itemId, qaLocationId, 'each');
  assert.ok(Math.abs(postVoidBalance) < 1e-6, `Expected post-void balance on-hand 0, got ${postVoidBalance}`);

  const retryWithSameKey = await apiRequest('POST', `/purchase-order-receipts/${receipt.receiptId}/void`, {
    token,
    headers: { 'Idempotency-Key': voidKey },
    body: { reason: 'supplier cancellation' }
  });
  assert.equal(retryWithSameKey.res.status, 200, JSON.stringify(retryWithSameKey.payload));

  const secondVoid = await apiRequest('POST', `/purchase-order-receipts/${receipt.receiptId}/void`, {
    token,
    body: { reason: 'duplicate request' }
  });
  assert.equal(secondVoid.res.status, 409, JSON.stringify(secondVoid.payload));

  const concurrentReceipt = await createPostedReceipt({
    token,
    quantity: 4,
    shipToLocationId: sellableLocationId,
    receivedToLocationId: qaLocationId
  });

  const [a, b] = await Promise.all([
    apiRequest('POST', `/purchase-order-receipts/${concurrentReceipt.receiptId}/void`, {
      token,
      body: { reason: 'race-a' }
    }),
    apiRequest('POST', `/purchase-order-receipts/${concurrentReceipt.receiptId}/void`, {
      token,
      body: { reason: 'race-b' }
    })
  ]);
  const statuses = [a.res.status, b.res.status];
  for (const status of statuses) {
    assert.ok(status === 200 || status === 409, `Unexpected concurrent void status: ${status}`);
  }

  const raceReversalCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND reversal_of_movement_id = $2`,
    [tenantId, concurrentReceipt.movementId]
  );
  assert.equal(Number(raceReversalCount.rows[0].count), 1);
});

test('void is rejected when receipt cost layers were consumed', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:consumed` });
  const qaLocationId = defaults.QA.id;
  const sellableLocationId = defaults.SELLABLE.id;

  const receipt = await createPostedReceipt({
    token,
    quantity: 3,
    shipToLocationId: sellableLocationId,
    receivedToLocationId: qaLocationId
  });

  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      reasonCode: 'consume',
      lines: [
        {
          lineNumber: 1,
          itemId: receipt.itemId,
          locationId: qaLocationId,
          uom: 'each',
          quantityDelta: -1,
          reasonCode: 'consume'
        }
      ]
    }
  });
  assert.equal(adjustmentRes.res.status, 201, JSON.stringify(adjustmentRes.payload));
  const postRes = await apiRequest('POST', `/inventory-adjustments/${adjustmentRes.payload.id}/post`, { token });
  assert.equal(postRes.res.status, 200, JSON.stringify(postRes.payload));

  const consumedVoid = await apiRequest('POST', `/purchase-order-receipts/${receipt.receiptId}/void`, {
    token,
    body: { reason: 'should fail due to consumed layer' }
  });
  assert.equal(consumedVoid.res.status, 409, JSON.stringify(consumedVoid.payload));

  const reversalCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND reversal_of_movement_id = $2`,
    [tenantId, receipt.movementId]
  );
  assert.equal(Number(reversalCount.rows[0].count), 0);
});
