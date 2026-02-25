import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const execFileAsync = promisify(execFile);
const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';

const ACCEPTABLE_SECONDARY_ERROR_CODES = new Set([
  'WO_POSTING_IDEMPOTENCY_INCOMPLETE',
  'WO_POSTING_IDEMPOTENCY_CONFLICT'
]);

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

async function createItem(token, defaultLocationId, skuPrefix, type = 'raw') {
  const sku = `${skuPrefix}-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      type,
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

async function createReceipt({ token, vendorId, itemId, locationId, quantity, unitCost, keySuffix }) {
  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId: locationId,
      receivingLocationId: locationId,
      expectedDate: '2026-01-10',
      status: 'approved',
      lines: [{ itemId, uom: 'each', quantityOrdered: quantity, unitCost, currencyCode: 'THB' }]
    }
  });
  assert.equal(poRes.res.status, 201, JSON.stringify(poRes.payload));

  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `wo-race-receipt:${keySuffix}:${itemId}` },
    body: {
      purchaseOrderId: poRes.payload.id,
      receivedAt: '2026-01-11T00:00:00.000Z',
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

async function qcAcceptReceiptLine(token, receiptLineId, quantity) {
  const res = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': `wo-race-qc:${receiptLineId}` },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity,
      uom: 'each',
      actorType: 'system'
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
}

async function createBom(token, outputItemId, components, suffix) {
  const res = await apiRequest('POST', '/boms', {
    token,
    body: {
      bomCode: `BOM-${suffix}-${randomUUID().slice(0, 6)}`,
      outputItemId,
      defaultUom: 'each',
      version: {
        versionNumber: 1,
        yieldQuantity: 1,
        yieldUom: 'each',
        components: components.map((component, index) => ({
          lineNumber: index + 1,
          componentItemId: component.componentItemId,
          uom: 'each',
          quantityPer: component.quantityPer
        }))
      }
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));

  const activateRes = await apiRequest('POST', `/boms/${res.payload.versions[0].id}/activate`, {
    token,
    body: { effectiveFrom: '2026-01-01T00:00:00.000Z' }
  });
  assert.equal(activateRes.res.status, 200, JSON.stringify(activateRes.payload));
  return res.payload.id;
}

async function createWorkOrder(token, params) {
  const res = await apiRequest('POST', '/work-orders', { token, body: params });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload;
}

async function runStrictInvariantsForTenant(tenantId) {
  await execFileAsync(
    process.execPath,
    ['scripts/inventory_invariants_check.mjs', '--strict', '--tenant-id', tenantId, '--limit', '25'],
    {
      cwd: process.cwd(),
      env: { ...process.env, ENABLE_SCHEDULER: 'false' },
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024
    }
  );
}

function getErrorCode(payload) {
  if (!payload) return null;
  if (typeof payload?.error === 'string') return payload.error;
  if (typeof payload?.error?.code === 'string') return payload.error.code;
  if (typeof payload?.code === 'string') return payload.code;
  return null;
}

test('concurrent report-production on same work order + same idempotency key posts exactly once', { timeout: 240000 }, async () => {
  const tenantSlug = `wo-report-idem-race-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'WO Report Production Idempotency Race Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  assert.ok(token);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const component = await createItem(token, defaults.SELLABLE.id, 'RACE-COMP', 'raw');
  const output = await createItem(token, defaults.QA.id, 'RACE-FG', 'finished');

  const receiptLine = await createReceipt({
    token,
    vendorId,
    itemId: component,
    locationId: defaults.SELLABLE.id,
    quantity: 200,
    unitCost: 9,
    keySuffix: tenantSlug
  });
  await qcAcceptReceiptLine(token, receiptLine, 200);

  const bomId = await createBom(token, output, [{ componentItemId: component, quantityPer: 2 }], tenantSlug);
  const workOrder = await createWorkOrder(token, {
    kind: 'production',
    outputItemId: output,
    outputUom: 'each',
    quantityPlanned: 20,
    bomId,
    defaultConsumeLocationId: defaults.SELLABLE.id,
    defaultProduceLocationId: defaults.QA.id
  });

  const idempotencyKey = `wo-report-idem-race:${tenantSlug}`;
  const requestBody = {
    warehouseId: warehouse.id,
    outputQty: 20,
    outputUom: 'each',
    occurredAt: '2026-02-16T00:00:00.000Z',
    idempotencyKey
  };

  const [first, second] = await Promise.all([
    apiRequest('POST', `/work-orders/${workOrder.id}/report-production`, {
      token,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: requestBody
    }),
    apiRequest('POST', `/work-orders/${workOrder.id}/report-production`, {
      token,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: requestBody
    })
  ]);

  const responses = [first, second];
  const success = responses.filter((entry) => entry.res.status >= 200 && entry.res.status < 300);
  assert.ok(success.length >= 1, `expected at least one success, got ${responses.map((r) => r.res.status).join(', ')}`);

  const failures = responses.filter((entry) => entry.res.status >= 400);
  if (failures.length > 0) {
    assert.equal(failures.length, 1, `expected at most one failure, got ${failures.length}`);
    assert.equal(failures[0].res.status, 409, JSON.stringify(failures[0].payload));
    const code = getErrorCode(failures[0].payload);
    assert.ok(
      code && ACCEPTABLE_SECONDARY_ERROR_CODES.has(code),
      `unexpected loser error code=${code} payload=${JSON.stringify(failures[0].payload)}`
    );
  }

  if (success.length >= 2) {
    assert.ok(success.some((entry) => entry.payload?.replayed === true), 'expected one replayed response');
    const successfulMovementPairs = success
      .map((entry) => `${entry.payload?.componentIssueMovementId}:${entry.payload?.productionReceiptMovementId}`);
    assert.equal(
      new Set(successfulMovementPairs).size,
      1,
      `all successful responses must point to the same movement pair; got ${successfulMovementPairs.join(',')}`
    );
  }

  const executionRes = await db.query(
    `SELECT id, consumption_movement_id, production_movement_id
       FROM work_order_executions
      WHERE tenant_id = $1
        AND work_order_id = $2
        AND idempotency_key = $3`,
    [tenantId, workOrder.id, idempotencyKey]
  );
  assert.equal(executionRes.rowCount, 1, `expected single execution for key ${idempotencyKey}`);

  const execution = executionRes.rows[0];
  assert.ok(execution.consumption_movement_id);
  assert.ok(execution.production_movement_id);

  const movementRes = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])`,
    [tenantId, [execution.consumption_movement_id, execution.production_movement_id]]
  );
  assert.equal(Number(movementRes.rows[0].count), 2);

  await runStrictInvariantsForTenant(tenantId);
});
