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

async function createItem(token, defaultLocationId, prefix) {
  const sku = `${prefix}-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      type: 'finished',
      isPurchasable: true,
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

async function createVendor(token, suffix) {
  const code = `V-${suffix}-${randomUUID().slice(0, 6)}`;
  const res = await apiRequest('POST', '/vendors', {
    token,
    body: { code, name: `Vendor ${code}` }
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
    headers: { 'Idempotency-Key': `tenant-scope-receipt:${keySuffix}:${itemId}` },
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
  const idempotencyKey = `tenant-scope-qc:${receiptLineId}`;
  const retryDelaysMs = [50, 100, 200];
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const res = await apiRequest('POST', '/qc-events', {
      token,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: {
        purchaseOrderReceiptLineId: receiptLineId,
        eventType: 'accept',
        quantity,
        uom: 'each',
        actorType: 'system'
      }
    });
    if (res.res.status === 201 || res.res.status === 200) {
      return;
    }
    if (res.res.status !== 409 || res.payload?.error?.code !== 'TX_RETRY_EXHAUSTED' || attempt === retryDelaysMs.length) {
      assert.equal(res.res.status, 201, JSON.stringify(res.payload));
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
  }
}

test('production areas and routings are tenant-scoped with per-tenant code uniqueness', { timeout: 180000 }, async () => {
  const suffix = randomUUID().slice(0, 8);
  const tenantA = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: `routing-scope-a-${suffix}`,
    tenantName: 'Routing Scope Tenant A'
  });
  const tenantB = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: `routing-scope-b-${suffix}`,
    tenantName: 'Routing Scope Tenant B'
  });

  const tokenA = tenantA.accessToken;
  const tokenB = tenantB.accessToken;
  const defaultsA = (await ensureStandardWarehouse({ token: tokenA, apiRequest, scope: import.meta.url })).defaults;
  const defaultsB = (await ensureStandardWarehouse({ token: tokenB, apiRequest, scope: `${import.meta.url}:tenant-b` })).defaults;

  const itemA = await createItem(tokenA, defaultsA.QA.id, 'TENANT-A');
  const itemB = await createItem(tokenB, defaultsB.QA.id, 'TENANT-B');
  const sharedCode = `PA-SHARED-${suffix}`;

  const areaA = await apiRequest('POST', '/work-centers', {
    token: tokenA,
    body: {
      code: sharedCode,
      name: 'Production Area A',
      locationId: defaultsA.QA.id,
      status: 'active'
    }
  });
  assert.equal(areaA.res.status, 201, JSON.stringify(areaA.payload));

  const duplicateSameTenant = await apiRequest('POST', '/work-centers', {
    token: tokenA,
    body: {
      code: sharedCode,
      name: 'Duplicate A',
      locationId: defaultsA.QA.id,
      status: 'active'
    }
  });
  assert.equal(duplicateSameTenant.res.status, 409, JSON.stringify(duplicateSameTenant.payload));

  const areaB = await apiRequest('POST', '/work-centers', {
    token: tokenB,
    body: {
      code: sharedCode,
      name: 'Production Area B',
      locationId: defaultsB.QA.id,
      status: 'active'
    }
  });
  assert.equal(areaB.res.status, 201, JSON.stringify(areaB.payload));

  const crossAreaRead = await apiRequest('GET', `/work-centers/${areaA.payload.id}`, { token: tokenB });
  assert.equal(crossAreaRead.res.status, 404, JSON.stringify(crossAreaRead.payload));

  const crossAreaUpdate = await apiRequest('PATCH', `/work-centers/${areaA.payload.id}`, {
    token: tokenB,
    body: { name: 'Tenant B should not update tenant A area' }
  });
  assert.equal(crossAreaUpdate.res.status, 404, JSON.stringify(crossAreaUpdate.payload));

  const routingA = await apiRequest('POST', '/routings', {
    token: tokenA,
    body: {
      itemId: itemA,
      name: 'Default A',
      version: 'v1',
      isDefault: true,
      status: 'active',
      steps: [
        {
          sequenceNumber: 10,
          workCenterId: areaA.payload.id,
          runTimeMinutes: 15,
          setupTimeMinutes: 5,
          machineTimeMinutes: 10
        }
      ]
    }
  });
  assert.equal(routingA.res.status, 201, JSON.stringify(routingA.payload));

  const crossRoutingRead = await apiRequest('GET', `/routings/${routingA.payload.id}`, { token: tokenB });
  assert.equal(crossRoutingRead.res.status, 404, JSON.stringify(crossRoutingRead.payload));

  const crossRoutingUpdate = await apiRequest('PATCH', `/routings/${routingA.payload.id}`, {
    token: tokenB,
    body: { name: 'Tenant B should not update tenant A routing' }
  });
  assert.equal(crossRoutingUpdate.res.status, 404, JSON.stringify(crossRoutingUpdate.payload));

  const routingB = await apiRequest('POST', '/routings', {
    token: tokenB,
    body: {
      itemId: itemB,
      name: 'Default B',
      version: 'v1',
      isDefault: true,
      status: 'active',
      steps: [
        {
          sequenceNumber: 10,
          workCenterId: areaB.payload.id,
          runTimeMinutes: 12,
          setupTimeMinutes: 4,
          machineTimeMinutes: 9
        }
      ]
    }
  });
  assert.equal(routingB.res.status, 201, JSON.stringify(routingB.payload));

  const crossItemList = await apiRequest('GET', `/items/${itemA}/routings`, { token: tokenB });
  assert.equal(crossItemList.res.status, 200, JSON.stringify(crossItemList.payload));
  assert.equal(Array.isArray(crossItemList.payload), true);
  assert.equal(crossItemList.payload.length, 0);
});

test('lot linkage tables reject cross-tenant rows and reports remain tenant-scoped', { timeout: 180000 }, async () => {
  const suffix = randomUUID().slice(0, 8);
  const tenantA = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: `lot-scope-a-${suffix}`,
    tenantName: 'Lot Scope Tenant A'
  });
  const tenantB = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: `lot-scope-b-${suffix}`,
    tenantName: 'Lot Scope Tenant B'
  });

  const tokenA = tenantA.accessToken;
  const tokenB = tenantB.accessToken;
  const dbA = tenantA.pool;
  const dbB = tenantB.pool;
  const defaultsA = (await ensureStandardWarehouse({ token: tokenA, apiRequest, scope: `${import.meta.url}:lot-a` })).defaults;
  const defaultsB = (await ensureStandardWarehouse({ token: tokenB, apiRequest, scope: `${import.meta.url}:lot-b` })).defaults;

  const itemA = await createItem(tokenA, defaultsA.SELLABLE.id, 'LOT-A');
  const itemB = await createItem(tokenB, defaultsB.SELLABLE.id, 'LOT-B');
  const vendorA = await createVendor(tokenA, `${suffix}-a`);
  const vendorB = await createVendor(tokenB, `${suffix}-b`);

  const receiptLineA = await createReceipt({
    token: tokenA,
    vendorId: vendorA,
    itemId: itemA,
    locationId: defaultsA.SELLABLE.id,
    quantity: 5,
    unitCost: 10,
    keySuffix: `a-${suffix}`
  });
  const receiptLineB = await createReceipt({
    token: tokenB,
    vendorId: vendorB,
    itemId: itemB,
    locationId: defaultsB.SELLABLE.id,
    quantity: 5,
    unitCost: 11,
    keySuffix: `b-${suffix}`
  });

  await qcAcceptReceiptLine(tokenA, receiptLineA, 5);
  await qcAcceptReceiptLine(tokenB, receiptLineB, 5);

  const lineARes = await dbA.query(
    `SELECT iml.id
       FROM inventory_movement_lines iml
       JOIN inventory_movements im
         ON im.id = iml.movement_id
        AND im.tenant_id = iml.tenant_id
      WHERE iml.tenant_id = $1
        AND iml.item_id = $2
      ORDER BY iml.created_at DESC
      LIMIT 1`,
    [tenantA.tenant.id, itemA]
  );
  const lineBRes = await dbB.query(
    `SELECT iml.id
       FROM inventory_movement_lines iml
       JOIN inventory_movements im
         ON im.id = iml.movement_id
        AND im.tenant_id = iml.tenant_id
      WHERE iml.tenant_id = $1
        AND iml.item_id = $2
      ORDER BY iml.created_at DESC
      LIMIT 1`,
    [tenantB.tenant.id, itemB]
  );
  assert.equal(lineARes.rowCount, 1);
  assert.equal(lineBRes.rowCount, 1);

  const lotAId = randomUUID();
  await dbA.query(
    `INSERT INTO lots (id, tenant_id, item_id, lot_code, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())`,
    [lotAId, tenantA.tenant.id, itemA, `LOT-A-${suffix}`]
  );

  const lotBId = randomUUID();
  await dbB.query(
    `INSERT INTO lots (id, tenant_id, item_id, lot_code, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())`,
    [lotBId, tenantB.tenant.id, itemB, `LOT-B-${suffix}`]
  );

  await assert.rejects(
    dbA.query(
      `INSERT INTO inventory_movement_lots (id, tenant_id, inventory_movement_line_id, lot_id, uom, quantity_delta, created_at)
       VALUES ($1, $2, $3, $4, 'each', 1, NOW())`,
      [randomUUID(), tenantA.tenant.id, lineBRes.rows[0].id, lotAId]
    ),
    (error) => error?.code === '23503'
  );

  await assert.rejects(
    dbA.query(
      `INSERT INTO inventory_movement_lots (id, tenant_id, inventory_movement_line_id, lot_id, uom, quantity_delta, created_at)
       VALUES ($1, $2, $3, $4, 'each', 1, NOW())`,
      [randomUUID(), tenantA.tenant.id, lineARes.rows[0].id, lotBId]
    ),
    (error) => error?.code === '23503'
  );

  const crossTenantReport = await apiRequest('GET', '/reports/movement-transactions', {
    token: tokenB,
    params: { itemId: itemA, limit: 10 }
  });
  assert.equal(crossTenantReport.res.status, 200, JSON.stringify(crossTenantReport.payload));
  assert.equal(Array.isArray(crossTenantReport.payload?.data), true);
  assert.equal(crossTenantReport.payload.data.length, 0, 'reports endpoint must not leak tenant A movement rows into tenant B');
});
