import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSession } from './helpers/ensureSession.mjs';
import { ensureStandardWarehouse } from './helpers/warehouse-bootstrap.mjs';
import { waitForCondition } from './helpers/waitFor.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = process.env.SEED_TENANT_SLUG || 'default';
let db;

async function apiRequest(method, path, { token, body, headers } = {}) {
  const url = new URL(baseUrl + path);
  const mergedHeaders = { 'Content-Type': 'application/json', ...(headers ?? {}) };
  if (token) mergedHeaders.Authorization = `Bearer ${token}`;
  const res = await fetch(url.toString(), {
    method,
    headers: mergedHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { res, payload };
}

async function getSession() {
  const session = await ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: 'QC Test Tenant'
  });
  db = session.pool;
  return session;
}

async function waitForOnHand(tenantId, itemId, locationId, expected, label) {
  return waitForCondition(
    async () => {
      const res = await db.query(
        `SELECT on_hand FROM inventory_balance WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4`,
        [tenantId, itemId, locationId, 'each']
      );
      if (res.rowCount === 0) return null;
      return Number(res.rows[0].on_hand);
    },
    (value) => value !== null && Math.abs(Number(value) - expected) < 1e-6,
    { label }
  );
}
test('QC accept is idempotent and creates no cost layers', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const userId = session.user?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});
  const qaLocation = defaults.QA;
  const sellableLocationId = defaults.SELLABLE.id;
  const qaLocationId = qaLocation.id;

  // Create vendor, item, PO
  const vendorRes = await apiRequest('POST', '/vendors', {
    token,
    body: { code: `V-${randomUUID()}`, name: 'Test Vendor' }
  });
  assert.equal(vendorRes.res.status, 201);

  const sku = `ITEM-${Date.now()}`;
  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: sellableLocationId
    }
  });
  assert.equal(itemRes.res.status, 201);
  const itemId = itemRes.payload.id;

  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId: vendorRes.payload.id,
      shipToLocationId: sellableLocationId,
      receivingLocationId: qaLocation.id,
      expectedDate: new Date().toISOString().slice(0, 10),
      status: 'approved',
      lines: [{ itemId, uom: 'each', quantityOrdered: 10, unitCost: 5, currencyCode: 'THB' }]
    }
  });
  assert.equal(poRes.res.status, 201);
  const poLineId = poRes.payload.lines[0].id;

  // Create receipt
  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `receipt-${randomUUID()}` },
    body: {
      purchaseOrderId: poRes.payload.id,
      receivedAt: new Date().toISOString(),
      lines: [{ purchaseOrderLineId: poLineId, uom: 'each', quantityReceived: 10, unitCost: 5 }]
    }
  });
  assert.equal(receiptRes.res.status, 201);
  const receiptLineId = receiptRes.payload.lines[0].id;

  const countReceiptLayers = async () => {
    const res = await db.query(
      `SELECT COUNT(*) AS count
         FROM inventory_cost_layers
        WHERE tenant_id = $1
          AND source_type = 'receipt'
          AND source_document_id = $2`,
      [tenantId, receiptLineId]
    );
    return Number(res.rows[0].count);
  };
  const costBefore = await countReceiptLayers();

  // Verify QA has stock
  const qaOnHandBefore = await waitForOnHand(
    tenantId,
    itemId,
    qaLocation.id,
    10,
    'qa on_hand after receipt'
  );
  assert.ok(Math.abs(Number(qaOnHandBefore) - 10) < 1e-6);

  // QC accept
  const qcKey = `qc-accept-${randomUUID()}`;
  const qcRes = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': qcKey },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity: 10,
      uom: 'each',
      actorType: 'user',
      actorId: userId
    }
  });
  assert.equal(qcRes.res.status, 201);
  const qcEventId = qcRes.payload.id;

  const costAfterFirst = await countReceiptLayers();
  assert.equal(costAfterFirst, costBefore);

  // Retry same QC accept (idempotent)
  const qcRetryRes = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': qcKey },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity: 10,
      uom: 'each',
      actorType: 'user',
      actorId: userId
    }
  });
  assert.equal(qcRetryRes.res.status, 200);
  assert.equal(qcRetryRes.payload.id, qcEventId);

  const costAfterSecond = await countReceiptLayers();
  assert.equal(costAfterSecond, costAfterFirst);

  // Verify only one transfer movement via qc_inventory_links
  const linksResult = await db.query(
    `SELECT inventory_movement_id FROM qc_inventory_links WHERE tenant_id = $1 AND qc_event_id = $2`,
    [tenantId, qcEventId]
  );
  assert.equal(linksResult.rowCount, 1, 'Should have exactly one transfer movement');
  const movementId = linksResult.rows[0].inventory_movement_id;

  // Verify it's a transfer
  const movementResult = await db.query(
    `SELECT movement_type, status FROM inventory_movements WHERE id = $1`,
    [movementId]
  );
  assert.equal(movementResult.rows[0].movement_type, 'transfer');
  assert.equal(movementResult.rows[0].status, 'posted');

  // Verify QA is 0, SELLABLE is 10
  const qaOnHandAfter = await waitForOnHand(
    tenantId,
    itemId,
    qaLocation.id,
    0,
    'qa on_hand after qc accept'
  );
  assert.ok(Math.abs(Number(qaOnHandAfter)) < 1e-6);

  const sellableOnHandAfter = await waitForOnHand(
    tenantId,
    itemId,
    sellableLocationId,
    10,
    'sellable on_hand after qc accept'
  );
  assert.ok(Math.abs(Number(sellableOnHandAfter) - 10) < 1e-6);
});

test('QC partial split: accept + hold', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const userId = session.user?.id;
  assert.ok(token);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});
  const qaLocationId = defaults.QA.id;
  const holdLocationId = defaults.HOLD.id;
  const sellableLocationId = defaults.SELLABLE.id;
  const qaLocation = defaults.QA;
  const holdLocation = defaults.HOLD;

  const vendorRes = await apiRequest('POST', '/vendors', {
    token,
    body: { code: `V-${randomUUID()}`, name: 'Vendor' }
  });
  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `ITEM-${Date.now()}`,
      name: 'Item',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: sellableLocationId
    }
  });
  const itemId = itemRes.payload.id;

  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId: vendorRes.payload.id,
      shipToLocationId: sellableLocationId,
      receivingLocationId: qaLocation.id,
      expectedDate: new Date().toISOString().slice(0, 10),
      status: 'approved',
      lines: [{ itemId, uom: 'each', quantityOrdered: 10, unitCost: 3, currencyCode: 'THB' }]
    }
  });

  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `receipt-${randomUUID()}` },
    body: {
      purchaseOrderId: poRes.payload.id,
      receivedAt: new Date().toISOString(),
      lines: [{ purchaseOrderLineId: poRes.payload.lines[0].id, uom: 'each', quantityReceived: 10, unitCost: 3 }]
    }
  });
  assert.equal(receiptRes.res.status, 201);
  const receiptLineId = receiptRes.payload.lines[0].id;

  // Accept 6
  const qcAcceptRes = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': `qc-accept-${randomUUID()}` },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity: 6,
      uom: 'each',
      actorType: 'user',
      actorId: userId
    }
  });
  assert.equal(qcAcceptRes.res.status, 201);

  // Hold 4
  const qcHoldRes = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': `qc-hold-${randomUUID()}` },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'hold',
      quantity: 4,
      uom: 'each',
      actorType: 'user',
      actorId: userId
    }
  });
  assert.equal(qcHoldRes.res.status, 201);

  // Verify balances
  const qaOnHand = await waitForOnHand(
    tenantId,
    itemId,
    qaLocation.id,
    0,
    'qa on_hand after qc split'
  );
  assert.ok(Math.abs(Number(qaOnHand)) < 1e-6, 'QA should be empty');

  const sellableOnHand = await waitForOnHand(
    tenantId,
    itemId,
    sellableLocationId,
    6,
    'sellable on_hand after qc split'
  );
  assert.ok(Math.abs(Number(sellableOnHand) - 6) < 1e-6, 'SELLABLE should be 6');

  const holdOnHand = await waitForOnHand(
    tenantId,
    itemId,
    holdLocation.id,
    4,
    'hold on_hand after qc split'
  );
  assert.ok(Math.abs(Number(holdOnHand) - 4) < 1e-6, 'HOLD should be 4');

  // Verify two transfer movements via qc_inventory_links
  const acceptLinks = await db.query(
    `SELECT inventory_movement_id FROM qc_inventory_links WHERE tenant_id = $1 AND qc_event_id = $2`,
    [tenantId, qcAcceptRes.payload.id]
  );
  assert.equal(acceptLinks.rowCount, 1, 'Accept should have one movement');

  const holdLinks = await db.query(
    `SELECT inventory_movement_id FROM qc_inventory_links WHERE tenant_id = $1 AND qc_event_id = $2`,
    [tenantId, qcHoldRes.payload.id]
  );
  assert.equal(holdLinks.rowCount, 1, 'Hold should have one movement');
});

test('QC validation: qty exceeds QA on-hand', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});
  const qaLocation = defaults.QA;
  const sellableLocationId = defaults.SELLABLE.id;

  const vendorRes = await apiRequest('POST', '/vendors', {
    token,
    body: { code: `V-${randomUUID()}`, name: 'Vendor' }
  });
  assert.equal(vendorRes.res.status, 201);

  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `ITEM-${Date.now()}`,
      name: 'Item',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: sellableLocationId
    }
  });
  assert.equal(itemRes.res.status, 201);

  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId: vendorRes.payload.id,
      shipToLocationId: sellableLocationId,
      receivingLocationId: qaLocation.id,
      expectedDate: new Date().toISOString().slice(0, 10),
      status: 'approved',
      lines: [{ itemId: itemRes.payload.id, uom: 'each', quantityOrdered: 10, unitCost: 5, currencyCode: 'THB' }]
    }
  });
  assert.equal(poRes.res.status, 201, JSON.stringify(poRes.payload));

  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `receipt-${randomUUID()}` },
    body: {
      purchaseOrderId: poRes.payload.id,
      receivedAt: new Date().toISOString(),
      lines: [{ 
        purchaseOrderLineId: poRes.payload.lines[0].id, 
        uom: 'each', 
        quantityReceived: 5, 
        unitCost: 5,
        discrepancyReason: 'short'
      }]
    }
  });
  assert.equal(receiptRes.res.status, 201, JSON.stringify(receiptRes.payload));

  // Try to accept 10 (exceeds received 5)
  const qcRes = await apiRequest('POST', '/qc-events', {
    token,
    body: {
      purchaseOrderReceiptLineId: receiptRes.payload.lines[0].id,
      eventType: 'accept',
      quantity: 10,
      uom: 'each',
      actorType: 'user'
    }
  });
  assert.equal(qcRes.res.status, 400);
  assert.match(qcRes.payload.error, /exceed/i);
});
