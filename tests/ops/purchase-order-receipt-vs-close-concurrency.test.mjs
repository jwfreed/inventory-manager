import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';

const RECEIPT_LOSER_CODES = new Set([
  'RECEIPT_PO_LINE_CLOSED',
  'RECEIPT_PO_CLOSED',
  'RECEIPT_PO_NOT_APPROVED'
]);

const CLOSE_LOSER_CODES = new Set([
  'PO_LINE_NOT_CLOSABLE',
  'PO_LINE_ALREADY_CLOSED',
  'PO_NOT_ELIGIBLE'
]);

function normalizeError(result) {
  const payload = result?.payload;
  const explicitCode = typeof payload?.code === 'string' ? payload.code.trim() : '';
  if (explicitCode) return explicitCode;

  const message = typeof payload?.error === 'string'
    ? payload.error
    : typeof payload?.message === 'string'
      ? payload.message
      : '';
  if (/closed\/cancelled\/completed purchase order lines/i.test(message)) return 'RECEIPT_PO_LINE_CLOSED';
  if (/already fully received\/closed/i.test(message)) return 'RECEIPT_PO_CLOSED';
  if (/must be approved before receiving/i.test(message)) return 'RECEIPT_PO_NOT_APPROVED';
  if (/po line cannot be closed in its current state/i.test(message)) return 'PO_LINE_NOT_CLOSABLE';
  if (/po line is already closed/i.test(message)) return 'PO_LINE_ALREADY_CLOSED';
  if (/purchase order cannot be closed in its current state/i.test(message)) return 'PO_NOT_ELIGIBLE';
  return 'UNKNOWN';
}

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

async function createItem(token, defaultLocationId, suffix = 'ITEM') {
  const sku = `${suffix}-${randomUUID().slice(0, 8)}`;
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

async function createPo(token, vendorId, receivingLocationId, lines) {
  const res = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      status: 'approved',
      expectedDate: '2026-04-15',
      shipToLocationId: receivingLocationId,
      receivingLocationId,
      lines
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload;
}

async function createReceipt(token, payload, key) {
  return apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': key },
    body: { ...payload, idempotencyKey: payload.idempotencyKey ?? key }
  });
}

async function closeLine(token, lineId, key) {
  return apiRequest('POST', `/purchase-order-lines/${lineId}/close`, {
    token,
    headers: { 'Idempotency-Key': key },
    body: {
      closeAs: 'short',
      reason: 'receipt_close_concurrency_test',
      notes: 'concurrency race',
      idempotencyKey: key
    }
  });
}

async function loadLineState(pool, tenantId, lineId) {
  const res = await pool.query(
    `SELECT status, closed_at
       FROM purchase_order_lines
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, lineId]
  );
  assert.equal(res.rowCount, 1, 'PO line missing');
  return {
    status: String(res.rows[0].status ?? ''),
    closedAt: res.rows[0].closed_at ? new Date(res.rows[0].closed_at) : null
  };
}

async function loadReceiptStatsForLine(pool, tenantId, lineId, externalRef) {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS receipt_count
       FROM purchase_order_receipts
      WHERE tenant_id = $1
        AND external_ref = $2`,
    [tenantId, externalRef]
  );
  const lineRes = await pool.query(
    `SELECT COUNT(*)::int AS line_count
       FROM purchase_order_receipt_lines porl
       JOIN purchase_order_receipts por
         ON por.id = porl.purchase_order_receipt_id
        AND por.tenant_id = porl.tenant_id
      WHERE por.tenant_id = $1
        AND porl.purchase_order_line_id = $2
        AND por.external_ref = $3`,
    [tenantId, lineId, externalRef]
  );
  return {
    receiptCount: Number(res.rows[0]?.receipt_count ?? 0),
    lineCount: Number(lineRes.rows[0]?.line_count ?? 0)
  };
}

test('receipt posting and line-close race serializes on row locks without mixed outcomes', { timeout: 180000 }, async () => {
  const tenantSlug = `po-receipt-close-race-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'PO Receipt vs Close Concurrency Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, defaults.SELLABLE.id, 'RACE');

  for (let i = 0; i < 10; i += 1) {
    const po = await createPo(token, vendorId, defaults.SELLABLE.id, [
      { lineNumber: 1, itemId, uom: 'each', quantityOrdered: 10, unitCost: 2, currencyCode: 'THB' }
    ]);
    const poLineId = po.lines[0].id;
    const receiptKey = `receipt-race-${tenantSlug}-${i}`;
    const closeKey = `close-race-${tenantSlug}-${i}`;
    const externalRef = `receipt-close-race:${tenantSlug}:${i}`;

    const [receiptRes, closeRes] = await Promise.all([
      createReceipt(token, {
        purchaseOrderId: po.id,
        receivedAt: '2026-04-10T00:00:00.000Z',
        externalRef,
        lines: [{ purchaseOrderLineId: poLineId, uom: 'each', quantityReceived: 10, unitCost: 100 }]
      }, receiptKey),
      closeLine(token, poLineId, closeKey)
    ]);

    const receiptSuccess = receiptRes.res.status >= 200 && receiptRes.res.status < 300;
    const closeSuccess = closeRes.res.status >= 200 && closeRes.res.status < 300;
    assert.equal(Number(receiptSuccess) + Number(closeSuccess), 1, `Expected one winner, got receipt=${receiptRes.res.status} close=${closeRes.res.status}`);

    const lineState = await loadLineState(session.pool, tenantId, poLineId);
    const receiptStats = await loadReceiptStatsForLine(session.pool, tenantId, poLineId, externalRef);

    if (receiptSuccess) {
      assert.equal(receiptRes.res.status, 201, JSON.stringify(receiptRes.payload));
      assert.ok(closeRes.res.status >= 400 && closeRes.res.status < 500, `expected close conflict, got ${closeRes.res.status}`);
      const closeLoserCode = normalizeError(closeRes);
      assert.ok(
        CLOSE_LOSER_CODES.has(closeLoserCode),
        `unexpected close loser code=${closeLoserCode} status=${closeRes.res.status} payload=${JSON.stringify(closeRes.payload)}`
      );
      assert.equal(lineState.status, 'complete');
      assert.equal(receiptStats.receiptCount, 1);
      assert.equal(receiptStats.lineCount, 1);
    } else {
      assert.equal(closeRes.res.status, 200, JSON.stringify(closeRes.payload));
      assert.equal(lineState.status, 'closed_short');
      assert.ok(
        receiptRes.res.status >= 400 && receiptRes.res.status < 500,
        `expected receipt conflict, got ${receiptRes.res.status}`
      );
      const receiptLoserCode = normalizeError(receiptRes);
      assert.ok(
        RECEIPT_LOSER_CODES.has(receiptLoserCode),
        `unexpected receipt loser code=${receiptLoserCode} status=${receiptRes.res.status} payload=${JSON.stringify(receiptRes.payload)}`
      );
      assert.equal(receiptStats.receiptCount, 0);
      assert.equal(receiptStats.lineCount, 0);
      if (lineState.closedAt) {
        const postCloseCountRes = await session.pool.query(
          `SELECT COUNT(*)::int AS count
             FROM purchase_order_receipt_lines porl
             JOIN purchase_order_receipts por
               ON por.id = porl.purchase_order_receipt_id
              AND por.tenant_id = porl.tenant_id
            WHERE por.tenant_id = $1
              AND porl.purchase_order_line_id = $2
              AND por.created_at >= $3`,
          [tenantId, poLineId, lineState.closedAt.toISOString()]
        );
        assert.equal(Number(postCloseCountRes.rows[0]?.count ?? 0), 0);
      }
    }
  }
});

test('closed purchase orders remain closed after receipt void triggers status recompute', async () => {
  const tenantSlug = `po-closed-terminal-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'PO Closed Terminal Status Tenant'
  });
  const token = session.accessToken;
  assert.ok(token);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:closed` });
  const vendorId = await createVendor(token);
  const itemA = await createItem(token, defaults.SELLABLE.id, 'CLOSED-A');
  const itemB = await createItem(token, defaults.SELLABLE.id, 'CLOSED-B');

  const po = await createPo(token, vendorId, defaults.SELLABLE.id, [
    { lineNumber: 1, itemId: itemA, uom: 'each', quantityOrdered: 10, unitCost: 3, currencyCode: 'THB' },
    { lineNumber: 2, itemId: itemB, uom: 'each', quantityOrdered: 20, unitCost: 4, currencyCode: 'THB' }
  ]);

  const receipt = await createReceipt(token, {
    purchaseOrderId: po.id,
    receivedAt: '2026-04-11T00:00:00.000Z',
    externalRef: `closed-terminal-receipt:${tenantSlug}`,
    lines: [{ purchaseOrderLineId: po.lines[0].id, uom: 'each', quantityReceived: 10, unitCost: 3 }]
  }, `closed-terminal-receipt:${tenantSlug}`);
  assert.equal(receipt.res.status, 201, JSON.stringify(receipt.payload));

  const closePo = await apiRequest('POST', `/purchase-orders/${po.id}/close`, {
    token,
    headers: { 'Idempotency-Key': `closed-terminal-close:${tenantSlug}` },
    body: {
      closeAs: 'closed',
      reason: 'closed_terminal_status_test',
      notes: 'close remaining lines before void',
      idempotencyKey: `closed-terminal-close:${tenantSlug}`
    }
  });
  assert.equal(closePo.res.status, 200, JSON.stringify(closePo.payload));
  assert.equal(closePo.payload.status, 'closed');

  const voidRes = await apiRequest('POST', `/purchase-order-receipts/${receipt.payload.id}/void`, {
    token,
    headers: { 'Idempotency-Key': `closed-terminal-void:${tenantSlug}` },
    body: { reason: 'closed terminal regression test' }
  });
  assert.equal(voidRes.res.status, 200, JSON.stringify(voidRes.payload));

  const poAfter = await apiRequest('GET', `/purchase-orders/${po.id}`, { token });
  assert.equal(poAfter.res.status, 200, JSON.stringify(poAfter.payload));
  assert.equal(poAfter.payload.status, 'closed');
});
