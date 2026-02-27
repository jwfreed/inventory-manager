import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';

function stableNormalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableNormalize(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableNormalize(entry)])
    );
  }
  return value;
}

function hashTransactionalRequest({ body }) {
  const normalized = stableNormalize(body ?? null);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function normalizeReceiptRequestForHash(body) {
  return {
    purchaseOrderId: body.purchaseOrderId,
    receivedAt: body.receivedAt ?? null,
    receivedToLocationId: body.receivedToLocationId ?? null,
    externalRef: body.externalRef ?? null,
    notes: body.notes ?? null,
    lines: [...body.lines]
      .map((line) => ({
        purchaseOrderLineId: line.purchaseOrderLineId,
        uom: line.uom,
        quantityReceived: Number(line.quantityReceived),
        unitCost: line.unitCost ?? null,
        discrepancyReason: line.discrepancyReason ?? null,
        discrepancyNotes: line.discrepancyNotes ?? null,
        lotCode: line.lotCode ?? null,
        serialNumbers: line.serialNumbers ?? null,
        overReceiptApproved: line.overReceiptApproved ?? false
      }))
      .sort((left, right) => left.purchaseOrderLineId.localeCompare(right.purchaseOrderLineId))
  };
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

async function createItem(token, locationId) {
  const sku = `IDEMP-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: locationId
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

test('transactional idempotency: duplicate replay returns same receipt without duplicate ledger rows', async () => {
  const tenantSlug = `tx-idem-receipt-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Transactional Idempotency Receipt Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, defaults.SELLABLE.id);
  const po = await createApprovedPurchaseOrder(token, vendorId, itemId, defaults.SELLABLE.id, 12, 5.25);

  const idempotencyKey = `tx-idem-receipt:${tenantSlug}`;
  const body = {
    purchaseOrderId: po.id,
    receivedAt: '2026-02-11T00:00:00.000Z',
    lines: [
      {
        purchaseOrderLineId: po.lines[0].id,
        uom: 'each',
        quantityReceived: 12,
        unitCost: 5.25
      }
    ]
  };

  const first = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body
  });
  assert.equal(first.res.status, 201, JSON.stringify(first.payload));

  const second = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body
  });
  assert.equal(second.res.status, 200, JSON.stringify(second.payload));
  assert.equal(second.payload.id, first.payload.id);

  const receiptId = first.payload.id;
  const movementId = first.payload.inventoryMovementId;
  const receiptCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM purchase_order_receipts
      WHERE tenant_id = $1
        AND idempotency_key = $2`,
    [tenantId, idempotencyKey]
  );
  assert.equal(Number(receiptCount.rows[0]?.count ?? 0), 1);

  const movementCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, movementId]
  );
  assert.equal(Number(movementCount.rows[0]?.count ?? 0), 1);

  const costLayerCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND movement_id = $2`,
    [tenantId, movementId]
  );
  assert.equal(Number(costLayerCount.rows[0]?.count ?? 0), 1);

  const idempotencyRow = await db.query(
    `SELECT endpoint, response_status
       FROM idempotency_keys
      WHERE tenant_id = $1
        AND key = $2`,
    [tenantId, idempotencyKey]
  );
  assert.equal(idempotencyRow.rowCount, 1);
  assert.equal(idempotencyRow.rows[0]?.endpoint, '/purchase-order-receipts');
  assert.equal(Number(idempotencyRow.rows[0]?.response_status ?? 0), 201);

  const receiptLines = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM purchase_order_receipt_lines
      WHERE tenant_id = $1
        AND purchase_order_receipt_id = $2`,
    [tenantId, receiptId]
  );
  assert.equal(Number(receiptLines.rows[0]?.count ?? 0), 1);
});

test('transactional idempotency: nested payload key order hashes identically and replays', async () => {
  const tenantSlug = `tx-idem-canonical-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Transactional Idempotency Canonical Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, defaults.SELLABLE.id);
  const po = await createApprovedPurchaseOrder(token, vendorId, itemId, defaults.SELLABLE.id, 9, 3.5);

  const idempotencyKey = `tx-idem-canonical:${tenantSlug}`;
  const canonicalBody = {
    purchaseOrderId: po.id,
    receivedAt: '2026-02-11T00:00:00.000Z',
    lines: [
      {
        purchaseOrderLineId: po.lines[0].id,
        uom: 'each',
        quantityReceived: 9,
        unitCost: 3.5
      }
    ]
  };
  const sameSemanticsReorderedBody = {
    lines: [
      {
        unitCost: 3.5,
        quantityReceived: 9,
        uom: 'each',
        purchaseOrderLineId: po.lines[0].id
      }
    ],
    receivedAt: '2026-02-11T00:00:00.000Z',
    purchaseOrderId: po.id
  };

  const first = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: canonicalBody
  });
  assert.equal(first.res.status, 201, JSON.stringify(first.payload));

  const replay = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: sameSemanticsReorderedBody
  });
  assert.equal(replay.res.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.payload.id, first.payload.id);

  const row = await db.query(
    `SELECT request_hash
       FROM idempotency_keys
      WHERE tenant_id = $1
        AND key = $2`,
    [tenantId, idempotencyKey]
  );
  assert.equal(row.rowCount, 1);
  assert.equal(
    row.rows[0].request_hash,
    hashTransactionalRequest({ body: normalizeReceiptRequestForHash(canonicalBody) })
  );
});

test('transactional idempotency: same endpoint key reuse with different payload is rejected', async () => {
  const tenantSlug = `tx-idem-payload-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Transactional Idempotency Payload Conflict Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, defaults.SELLABLE.id);
  const po = await createApprovedPurchaseOrder(token, vendorId, itemId, defaults.SELLABLE.id, 10, 4.7);

  const idempotencyKey = `tx-idem-payload:${tenantSlug}`;
  const firstBody = {
    purchaseOrderId: po.id,
    receivedAt: '2026-02-11T00:00:00.000Z',
    lines: [{ purchaseOrderLineId: po.lines[0].id, uom: 'each', quantityReceived: 10, unitCost: 4.7 }]
  };
  const conflictingBody = {
    purchaseOrderId: po.id,
    receivedAt: '2026-02-11T00:00:00.000Z',
    lines: [{ purchaseOrderLineId: po.lines[0].id, uom: 'each', quantityReceived: 9, unitCost: 4.7 }]
  };

  const first = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: firstBody
  });
  assert.equal(first.res.status, 201, JSON.stringify(first.payload));

  const second = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: conflictingBody
  });
  assert.equal(second.res.status, 409, JSON.stringify(second.payload));
  assert.equal(second.payload?.error?.code, 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD');

  const receiptCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM purchase_order_receipts
      WHERE tenant_id = $1
        AND idempotency_key = $2`,
    [tenantId, idempotencyKey]
  );
  assert.equal(Number(receiptCount.rows[0]?.count ?? 0), 1);
});

test('transactional idempotency: cross-endpoint reuse is rejected and does not mutate', async () => {
  const tenantSlug = `tx-idem-endpoint-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Transactional Idempotency Endpoint Conflict Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, defaults.SELLABLE.id);
  const po = await createApprovedPurchaseOrder(token, vendorId, itemId, defaults.SELLABLE.id, 6, 5.6);

  const idempotencyKey = `tx-idem-endpoint:${tenantSlug}`;
  const createRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      purchaseOrderId: po.id,
      receivedAt: '2026-02-11T00:00:00.000Z',
      lines: [{ purchaseOrderLineId: po.lines[0].id, uom: 'each', quantityReceived: 6, unitCost: 5.6 }]
    }
  });
  assert.equal(createRes.res.status, 201, JSON.stringify(createRes.payload));
  const receiptId = createRes.payload.id;

  const beforeVoid = await db.query(
    `SELECT status
       FROM purchase_order_receipts
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, receiptId]
  );
  assert.equal(beforeVoid.rows[0]?.status, 'posted');

  const voidRes = await apiRequest('POST', `/purchase-order-receipts/${receiptId}/void`, {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: { reason: 'should-conflict' }
  });
  assert.equal(voidRes.res.status, 409, JSON.stringify(voidRes.payload));
  assert.equal(voidRes.payload?.error?.code, 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS');

  const afterVoid = await db.query(
    `SELECT status
       FROM purchase_order_receipts
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, receiptId]
  );
  assert.equal(afterVoid.rows[0]?.status, 'posted');
});

test('transactional idempotency: five parallel duplicate requests produce one receipt', async () => {
  const tenantSlug = `tx-idem-race-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Transactional Idempotency Parallel Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, defaults.SELLABLE.id);
  const po = await createApprovedPurchaseOrder(token, vendorId, itemId, defaults.SELLABLE.id, 20, 4.1);

  const idempotencyKey = `tx-idem-race:${tenantSlug}`;
  const body = {
    purchaseOrderId: po.id,
    receivedAt: '2026-02-12T00:00:00.000Z',
    lines: [
      {
        purchaseOrderLineId: po.lines[0].id,
        uom: 'each',
        quantityReceived: 20,
        unitCost: 4.1
      }
    ]
  };

  const responses = await Promise.all(
    Array.from({ length: 5 }).map(() =>
      apiRequest('POST', '/purchase-order-receipts', {
        token,
        headers: { 'Idempotency-Key': idempotencyKey },
        body
      })
    )
  );

  for (const response of responses) {
    assert.ok([200, 201].includes(response.res.status), JSON.stringify(response.payload));
  }

  const receiptIds = new Set(responses.map((response) => response.payload?.id).filter(Boolean));
  assert.equal(receiptIds.size, 1, `expected one receipt id, got ${JSON.stringify([...receiptIds])}`);

  const receiptCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM purchase_order_receipts
      WHERE tenant_id = $1
        AND idempotency_key = $2`,
    [tenantId, idempotencyKey]
  );
  assert.equal(Number(receiptCount.rows[0]?.count ?? 0), 1);

  const idempotencyCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM idempotency_keys
      WHERE tenant_id = $1
        AND key = $2`,
    [tenantId, idempotencyKey]
  );
  assert.equal(Number(idempotencyCount.rows[0]?.count ?? 0), 1);
});

test('transactional idempotency: incomplete key row blocks replay and prevents duplicate posting', async () => {
  const tenantSlug = `tx-idem-crash-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Transactional Idempotency Crash Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, defaults.SELLABLE.id);
  const po = await createApprovedPurchaseOrder(token, vendorId, itemId, defaults.SELLABLE.id, 8, 2.5);

  const idempotencyKey = `tx-idem-incomplete:${tenantSlug}`;
  const body = {
    purchaseOrderId: po.id,
    receivedAt: '2026-02-13T00:00:00.000Z',
    lines: [
      {
        purchaseOrderLineId: po.lines[0].id,
        uom: 'each',
        quantityReceived: 8,
        unitCost: 2.5
      }
    ]
  };
  const requestHash = hashTransactionalRequest({ body: normalizeReceiptRequestForHash(body) });

  await db.query(
    `INSERT INTO idempotency_keys (
        tenant_id,
        key,
        endpoint,
        request_hash,
        response_status,
        response_body,
        status,
        response_ref,
        updated_at,
        created_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'IN_PROGRESS', NULL, now(), now())
     ON CONFLICT (tenant_id, key) DO UPDATE
         SET endpoint = EXCLUDED.endpoint,
             request_hash = EXCLUDED.request_hash,
             response_status = EXCLUDED.response_status,
             response_body = EXCLUDED.response_body,
             status = EXCLUDED.status,
             response_ref = EXCLUDED.response_ref,
             updated_at = now(),
             created_at = now()`,
    [tenantId, idempotencyKey, '/purchase-order-receipts', requestHash, -1, JSON.stringify({ code: 'IDEMPOTENCY_IN_PROGRESS' })]
  );

  const replayAttempt = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body
  });
  assert.equal(replayAttempt.res.status, 409, JSON.stringify(replayAttempt.payload));

  const receiptCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM purchase_order_receipts
      WHERE tenant_id = $1
        AND idempotency_key = $2`,
    [tenantId, idempotencyKey]
  );
  assert.equal(Number(receiptCount.rows[0]?.count ?? 0), 0);

  const movementCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND idempotency_key = $2`,
    [tenantId, idempotencyKey]
  );
  assert.equal(Number(movementCount.rows[0]?.count ?? 0), 0);
});
