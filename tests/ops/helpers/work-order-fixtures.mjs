import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);
const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

export const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
export const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';

export async function apiRequest(method, path, { token, body, params, headers } = {}) {
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

export async function createVendor(token) {
  const code = `V-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/vendors', {
    token,
    body: { code, name: `Vendor ${code}` }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

export async function createItem(token, defaultLocationId, skuPrefix, type = 'raw') {
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

export async function createReceipt({
  token,
  vendorId,
  itemId,
  locationId,
  quantity,
  unitCost,
  keySuffix,
  receivedAt = '2026-01-11T00:00:00.000Z'
}) {
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
    headers: { 'Idempotency-Key': `wo-fixture-receipt:${keySuffix}:${itemId}` },
    body: {
      purchaseOrderId: poRes.payload.id,
      receivedAt,
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

export async function qcAcceptReceiptLine(token, receiptLineId, quantity) {
  const res = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': `wo-fixture-qc:${receiptLineId}` },
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

export async function createBom(token, outputItemId, components, suffix) {
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

export async function createWorkOrder(token, params) {
  const res = await apiRequest('POST', '/work-orders', {
    token,
    body: params
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload;
}

export async function readOnHand(pool, tenantId, itemId, locationId) {
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

export async function runStrictInvariantsForTenant(tenantId) {
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
