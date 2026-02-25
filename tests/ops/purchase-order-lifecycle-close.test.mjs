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

async function createItem(token, defaultLocationId) {
  const sku = `ITEM-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      type: 'raw',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createPo(token, vendorId, receivingLocationId, lines, vendorReference = null) {
  const body = {
    vendorId,
    status: 'approved',
    expectedDate: '2026-04-10',
    shipToLocationId: receivingLocationId,
    receivingLocationId,
    lines
  };
  if (vendorReference) {
    body.vendorReference = vendorReference;
  }
  const res = await apiRequest('POST', '/purchase-orders', {
    token,
    body
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload;
}

async function createReceipt(token, payload, key = `receipt-${randomUUID()}`) {
  return apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': key },
    body: { ...payload, idempotencyKey: payload.idempotencyKey ?? key }
  });
}

async function movementCount(pool, tenantId) {
  const res = await pool.query('SELECT COUNT(*)::int AS count FROM inventory_movements WHERE tenant_id = $1', [tenantId]);
  return Number(res.rows[0]?.count ?? 0);
}

test('partial receipt without discrepancyReason succeeds and keeps line open', async () => {
  const tenantSlug = `po-lifecycle-partial-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'PO Lifecycle Partial Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, defaults.SELLABLE.id);
  const po = await createPo(token, vendorId, defaults.SELLABLE.id, [
    { lineNumber: 1, itemId, uom: 'each', quantityOrdered: 45, unitCost: 2, currencyCode: 'THB' }
  ]);

  const receiptRes = await createReceipt(token, {
    purchaseOrderId: po.id,
    receivedAt: '2026-04-01T00:00:00.000Z',
    lines: [
      {
        purchaseOrderLineId: po.lines[0].id,
        uom: 'each',
        quantityReceived: 10,
        unitCost: 2
      }
    ]
  });
  assert.equal(receiptRes.res.status, 201, JSON.stringify(receiptRes.payload));
  assert.equal(receiptRes.payload?.lines?.[0]?.discrepancyReason ?? null, null);

  const poFetch = await apiRequest('GET', `/purchase-orders/${po.id}`, { token });
  assert.equal(poFetch.res.status, 200, JSON.stringify(poFetch.payload));
  assert.equal(poFetch.payload.status, 'partially_received');
  assert.equal(poFetch.payload.lines[0].status, 'open');
  assert.equal(Number(poFetch.payload.lines[0].quantityReceived), 10);
});

test('over-receipt requires explicit approval and discrepancy reason over', async () => {
  const tenantSlug = `po-lifecycle-over-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'PO Lifecycle Over Receipt Tenant'
  });
  const token = session.accessToken;
  assert.ok(token);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, defaults.SELLABLE.id);
  const po = await createPo(token, vendorId, defaults.SELLABLE.id, [
    { lineNumber: 1, itemId, uom: 'each', quantityOrdered: 10, unitCost: 2, currencyCode: 'THB' }
  ]);

  const noApproval = await createReceipt(token, {
    purchaseOrderId: po.id,
    receivedAt: '2026-04-02T00:00:00.000Z',
    lines: [
      {
        purchaseOrderLineId: po.lines[0].id,
        uom: 'each',
        quantityReceived: 12,
        unitCost: 2
      }
    ]
  });
  assert.equal(noApproval.res.status, 409, JSON.stringify(noApproval.payload));
  assert.match(String(noApproval.payload?.error ?? ''), /Over-receipt requires explicit approval/i);

  const noOverReason = await createReceipt(token, {
    purchaseOrderId: po.id,
    receivedAt: '2026-04-02T01:00:00.000Z',
    lines: [
      {
        purchaseOrderLineId: po.lines[0].id,
        uom: 'each',
        quantityReceived: 12,
        unitCost: 2,
        overReceiptApproved: true
      }
    ]
  });
  assert.equal(noOverReason.res.status, 400, JSON.stringify(noOverReason.payload));
  assert.match(String(noOverReason.payload?.error ?? ''), /Discrepancy reason "over" is required/i);
});

test('line close as short is idempotent and blocks further receipts without posting movements', async () => {
  const tenantSlug = `po-lifecycle-line-close-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'PO Lifecycle Line Close Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, defaults.SELLABLE.id);
  const po = await createPo(token, vendorId, defaults.SELLABLE.id, [
    { lineNumber: 1, itemId, uom: 'each', quantityOrdered: 45, unitCost: 2, currencyCode: 'THB' }
  ]);

  const receipt = await createReceipt(token, {
    purchaseOrderId: po.id,
    receivedAt: '2026-04-03T00:00:00.000Z',
    lines: [
      {
        purchaseOrderLineId: po.lines[0].id,
        uom: 'each',
        quantityReceived: 10,
        unitCost: 2
      }
    ]
  });
  assert.equal(receipt.res.status, 201, JSON.stringify(receipt.payload));

  const beforeMovements = await movementCount(session.pool, tenantId);
  const closeKey = `line-close-${randomUUID()}`;
  const closeRes = await apiRequest('POST', `/purchase-order-lines/${po.lines[0].id}/close`, {
    token,
    headers: { 'Idempotency-Key': closeKey },
    body: {
      closeAs: 'short',
      reason: 'integration_test_short_close',
      notes: 'close remainder',
      idempotencyKey: closeKey
    }
  });
  assert.equal(closeRes.res.status, 200, JSON.stringify(closeRes.payload));
  assert.equal(closeRes.payload?.line?.status, 'closed_short');

  const closeReplay = await apiRequest('POST', `/purchase-order-lines/${po.lines[0].id}/close`, {
    token,
    headers: { 'Idempotency-Key': closeKey },
    body: {
      closeAs: 'short',
      reason: 'integration_test_short_close',
      notes: 'close remainder',
      idempotencyKey: closeKey
    }
  });
  assert.equal(closeReplay.res.status, 200, JSON.stringify(closeReplay.payload));
  assert.equal(closeReplay.payload?.line?.status, 'closed_short');

  const afterMovements = await movementCount(session.pool, tenantId);
  assert.equal(afterMovements, beforeMovements, 'line close should not post inventory movements');

  const blockedReceipt = await createReceipt(token, {
    purchaseOrderId: po.id,
    receivedAt: '2026-04-04T00:00:00.000Z',
    lines: [
      {
        purchaseOrderLineId: po.lines[0].id,
        uom: 'each',
        quantityReceived: 1,
        unitCost: 2
      }
    ]
  });
  assert.equal(blockedReceipt.res.status, 409, JSON.stringify(blockedReceipt.payload));
  assert.match(
    String(blockedReceipt.payload?.error ?? ''),
    /(already fully received\/closed|closed\/cancelled\/completed)/i
  );
});

test('PO close endpoint closes remaining open lines and is idempotent without movement side effects', async () => {
  const tenantSlug = `po-lifecycle-po-close-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'PO Lifecycle PO Close Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const itemA = await createItem(token, defaults.SELLABLE.id);
  const itemB = await createItem(token, defaults.SELLABLE.id);
  const po = await createPo(
    token,
    vendorId,
    defaults.SELLABLE.id,
    [
      { lineNumber: 1, itemId: itemA, uom: 'each', quantityOrdered: 10, unitCost: 2, currencyCode: 'THB' },
      { lineNumber: 2, itemId: itemB, uom: 'each', quantityOrdered: 20, unitCost: 3, currencyCode: 'THB' }
    ],
    `seed:integration:po-close:${randomUUID().slice(0, 8)}`
  );

  const firstReceipt = await createReceipt(token, {
    purchaseOrderId: po.id,
    receivedAt: '2026-04-05T00:00:00.000Z',
    lines: [
      {
        purchaseOrderLineId: po.lines[0].id,
        uom: 'each',
        quantityReceived: 10,
        unitCost: 2
      }
    ]
  });
  assert.equal(firstReceipt.res.status, 201, JSON.stringify(firstReceipt.payload));

  const cancelBlocked = await apiRequest('POST', `/purchase-orders/${po.id}/close`, {
    token,
    body: {
      closeAs: 'cancelled',
      reason: 'integration_test_cancel_block',
      notes: 'cancel should be blocked after posted receipt'
    }
  });
  assert.equal(cancelBlocked.res.status, 409, JSON.stringify(cancelBlocked.payload));
  assert.match(String(cancelBlocked.payload?.error ?? ''), /cannot be cancelled/i);

  const beforeMovements = await movementCount(session.pool, tenantId);
  const closeKey = `po-close-${randomUUID()}`;
  const poClose = await apiRequest('POST', `/purchase-orders/${po.id}/close`, {
    token,
    headers: { 'Idempotency-Key': closeKey },
    body: {
      closeAs: 'closed',
      reason: 'integration_test_po_close',
      notes: 'close remaining lines',
      idempotencyKey: closeKey
    }
  });
  assert.equal(poClose.res.status, 200, JSON.stringify(poClose.payload));
  assert.equal(poClose.payload.status, 'closed');
  const line1 = poClose.payload.lines.find((line) => line.id === po.lines[0].id);
  const line2 = poClose.payload.lines.find((line) => line.id === po.lines[1].id);
  assert.equal(line1?.status, 'complete');
  assert.equal(line2?.status, 'closed_short');

  const replay = await apiRequest('POST', `/purchase-orders/${po.id}/close`, {
    token,
    headers: { 'Idempotency-Key': closeKey },
    body: {
      closeAs: 'closed',
      reason: 'integration_test_po_close',
      notes: 'close remaining lines',
      idempotencyKey: closeKey
    }
  });
  assert.equal(replay.res.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.payload.status, 'closed');

  const afterMovements = await movementCount(session.pool, tenantId);
  assert.equal(afterMovements, beforeMovements, 'PO close should not post inventory movements');
});
