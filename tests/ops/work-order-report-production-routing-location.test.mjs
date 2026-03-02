import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
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
  const payload = contentType.includes('application/json')
    ? await res.json().catch(() => null)
    : await res.text().catch(() => '');
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

async function createItem(token, defaultLocationId, prefix, type = 'raw') {
  const sku = `${prefix}-${randomUUID().slice(0, 8)}`;
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
    headers: { 'Idempotency-Key': `wo-routing-receipt:${keySuffix}:${itemId}` },
    body: {
      purchaseOrderId: poRes.payload.id,
      receivedAt: '2026-02-14T00:00:00.000Z',
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
    headers: { 'Idempotency-Key': `wo-routing-qc:${receiptLineId}` },
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

async function createBom(token, outputItemId, componentItemId, suffix) {
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
        components: [
          {
            lineNumber: 1,
            componentItemId,
            uom: 'each',
            quantityPer: 1
          }
        ]
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

async function createWorkOrder(token, body) {
  const res = await apiRequest('POST', '/work-orders', { token, body });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload;
}

test('report-production receives output to routing final-step production area location and writes output lot link', { timeout: 240000 }, async () => {
  const tenantSlug = `wo-routing-loc-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'WO Routing Location Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const componentItemId = await createItem(token, defaults.SELLABLE.id, 'RAW-ROUTING', 'raw');
  const outputItemId = await createItem(token, defaults.QA.id, 'FG-ROUTING', 'finished');

  const receiptLineId = await createReceipt({
    token,
    vendorId,
    itemId: componentItemId,
    locationId: defaults.SELLABLE.id,
    quantity: 100,
    unitCost: 5,
    keySuffix: tenantSlug
  });
  await qcAcceptReceiptLine(token, receiptLineId, 100);

  const productionAreaLocationRes = await apiRequest('POST', '/locations', {
    token,
    body: {
      code: `PA-OUT-${randomUUID().slice(0, 6)}`,
      name: 'Production Area Output Bin',
      type: 'bin',
      role: 'QA',
      isSellable: false,
      parentLocationId: warehouse.id,
      active: true
    }
  });
  assert.equal(productionAreaLocationRes.res.status, 201, JSON.stringify(productionAreaLocationRes.payload));
  const productionAreaLocationId = productionAreaLocationRes.payload.id;

  const productionAreaRes = await apiRequest('POST', '/work-centers', {
    token,
    body: {
      code: `PA-${randomUUID().slice(0, 8)}`,
      name: 'Conche Room',
      locationId: productionAreaLocationId,
      status: 'active'
    }
  });
  assert.equal(productionAreaRes.res.status, 201, JSON.stringify(productionAreaRes.payload));

  const routingRes = await apiRequest('POST', '/routings', {
    token,
    body: {
      itemId: outputItemId,
      name: 'Default Routing',
      version: 'v1',
      isDefault: true,
      status: 'active',
      steps: [
        {
          sequenceNumber: 5,
          workCenterId: productionAreaRes.payload.id,
          setupTimeMinutes: 10,
          runTimeMinutes: 30,
          machineTimeMinutes: 20
        }
      ]
    }
  });
  assert.equal(routingRes.res.status, 201, JSON.stringify(routingRes.payload));

  const bomId = await createBom(token, outputItemId, componentItemId, tenantSlug);
  const workOrder = await createWorkOrder(token, {
    kind: 'production',
    outputItemId,
    outputUom: 'each',
    quantityPlanned: 10,
    bomId,
    defaultConsumeLocationId: defaults.SELLABLE.id,
    defaultProduceLocationId: defaults.QA.id
  });

  const reportRes = await apiRequest('POST', `/work-orders/${workOrder.id}/report-production`, {
    token,
    headers: { 'Idempotency-Key': `wo-routing-report:${tenantSlug}` },
    body: {
      warehouseId: warehouse.id,
      outputQty: 10,
      outputUom: 'each',
      occurredAt: '2026-02-15T00:00:00.000Z'
    }
  });
  assert.equal(reportRes.res.status, 201, JSON.stringify(reportRes.payload));
  assert.equal(reportRes.payload?.lotTracking?.inputLotCount, 0);
  assert.ok(reportRes.payload?.lotTracking?.outputLotId);

  const producedLineRes = await db.query(
    `SELECT location_id
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
        AND item_id = $3
      LIMIT 1`,
    [tenantId, reportRes.payload.productionReceiptMovementId, outputItemId]
  );
  assert.equal(producedLineRes.rowCount, 1);
  assert.equal(producedLineRes.rows[0].location_id, productionAreaLocationId);

  const lotLinkRes = await db.query(
    `SELECT lot_id, role, quantity
       FROM work_order_lot_links
      WHERE tenant_id = $1
        AND work_order_execution_id = $2
        AND role = 'produce'`,
    [tenantId, reportRes.payload.productionReportId]
  );
  assert.equal(lotLinkRes.rowCount, 1);
  assert.equal(lotLinkRes.rows[0].lot_id, reportRes.payload.lotTracking.outputLotId);
  assert.equal(Number(lotLinkRes.rows[0].quantity), 10);
});
