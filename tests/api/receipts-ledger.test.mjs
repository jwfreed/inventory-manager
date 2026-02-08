import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSession } from './helpers/ensureSession.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = process.env.SEED_TENANT_SLUG || 'default';
let db;

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
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { res, payload };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function assertOk(res, label, payload, requestBody, allowed = [200, 201]) {
  if (!allowed.includes(res.status)) {
    const body = typeof payload === 'string' ? payload : safeJson(payload);
    const req = requestBody ? safeJson(requestBody) : '';
    throw new Error(`BOOTSTRAP_FAILED ${label} status=${res.status} body=${body}${req ? ` request=${req}` : ''}`);
  }
}

function isDescendant(location, warehouseId, byId) {
  let current = location;
  const visited = new Set();
  let depth = 0;
  while (current && current.parentLocationId) {
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    if (current.parentLocationId === warehouseId) return true;
    current = byId.get(current.parentLocationId);
    depth += 1;
    if (depth > 20) return false;
  }
  return false;
}

function formatLocation(location) {
  if (!location) return null;
  return {
    id: location.id,
    code: location.code,
    name: location.name,
    type: location.type,
    role: location.role,
    parentLocationId: location.parentLocationId
  };
}

async function getSession() {
  const session = await ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: 'Receipt Test Tenant'
  });
  db = session.pool;
  return session;
}

async function getLocationByCode(token, code) {
  const res = await apiRequest('GET', '/locations', { token, params: { limit: 200 } });
  assert.equal(res.res.status, 200);
  const rows = res.payload.data || [];
  return rows.find((loc) => loc.code === code) || null;
}

async function getLocationByRole(token, role) {
  const res = await apiRequest('GET', '/locations', { token, params: { limit: 200 } });
  assert.equal(res.res.status, 200);
  const rows = res.payload.data || [];
  return rows.find((loc) => loc.role === role) || null;
}

test('PO receipt posts ledger into QA and QC reclassifies without new cost layers', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const userId = session.user?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const locationsRes = await apiRequest('GET', '/locations', { token });
  assert.equal(locationsRes.res.status, 200);
  let locations = locationsRes.payload.data || [];
  let warehouse = locations.find((loc) => loc.type === 'warehouse');
  if (!warehouse) {
    const code = `WH-${randomUUID()}`;
    const body = {
      code,
      name: `Warehouse ${code}`,
      type: 'warehouse',
      role: null,
      isSellable: false,
      active: true
    };
    const createRes = await apiRequest('POST', '/locations', { token, body });
    assertOk(createRes.res, 'POST /locations (warehouse)', createRes.payload, body, [201]);
    warehouse = createRes.payload;
    locations = [...locations, warehouse];
  }
  const ensureRole = async (role) => {
    let loc = locations.find(
      (entry) => entry.role === role && entry.parentLocationId === warehouse.id
    );
    if (!loc) {
      const code = `${role}-${randomUUID().slice(0, 8)}`;
      const body = {
        code,
        name: `${role} Location`,
        type: role === 'SCRAP' ? 'scrap' : 'bin',
        role,
        isSellable: role === 'SELLABLE',
        parentLocationId: warehouse.id
      };
      const createRes = await apiRequest('POST', '/locations', { token, body });
      assertOk(createRes.res, `POST /locations (${role})`, createRes.payload, body, [201]);
      loc = createRes.payload;
      locations = [...locations, loc];
    }
    await db.query(
      `INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [tenantId, warehouse.id, role, loc.id]
    );
    return loc;
  };
  await ensureRole('SELLABLE');
  await ensureRole('QA');

  // Find warehouse and get warehouse defaults
  assert.ok(warehouse, 'Warehouse required');

  // Get warehouse default locations - these are what the receipt service will use
  const defaultsRes = await db.query(
    `SELECT role, location_id FROM warehouse_default_location WHERE tenant_id = $1 AND warehouse_id = $2`,
    [tenantId, warehouse.id]
  );
  const defaults = new Map(defaultsRes.rows.map(r => [r.role, r.location_id]));
  const qaLocationId = defaults.get('QA');
  const sellableLocationId = defaults.get('SELLABLE');
  assert.ok(qaLocationId, 'QA default required');
  assert.ok(sellableLocationId, 'SELLABLE default required');

  // Get location objects for the defaults
  const qaLocation = locations.find(l => l.id === qaLocationId);
  const fgLocation = locations.find(l => l.id === sellableLocationId);
  assert.ok(qaLocation, 'QA location must exist');
  assert.ok(fgLocation, 'Sellable location must exist');
  const byId = new Map(locations.map((loc) => [loc.id, loc]));
  const diagnostics = {
    warehouseId: warehouse.id,
    warehouse: formatLocation(warehouse),
    qaLocation: formatLocation(qaLocation),
    sellableLocation: formatLocation(fgLocation),
    locations: locations.map(formatLocation),
    defaults: defaultsRes.rows
  };
  if (warehouse.parentLocationId !== null || warehouse.type !== 'warehouse') {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID root\n${safeJson(diagnostics)}`);
  }
  if (!qaLocation.parentLocationId || !isDescendant(qaLocation, warehouse.id, byId)) {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID qa\n${safeJson(diagnostics)}`);
  }
  if (!fgLocation.parentLocationId || !isDescendant(fgLocation, warehouse.id, byId)) {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID sellable\n${safeJson(diagnostics)}`);
  }

  const vendorCode = `V-${Date.now()}`;
  const vendorRes = await apiRequest('POST', '/vendors', {
    token,
    body: { code: vendorCode, name: `Vendor ${vendorCode}` }
  });
  assert.equal(vendorRes.res.status, 201);
  const vendorId = vendorRes.payload.id;

  const sku = `ITEM-${randomUUID()}`;
  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: fgLocation.id
    }
  });
  assert.equal(itemRes.res.status, 201);
  const itemId = itemRes.payload.id;

  const sellableQaRes = await apiRequest('POST', '/locations', {
    token,
    body: {
      code: `QA-SELL-${Date.now()}`,
      name: 'QA',
      type: 'bin',
      parentLocationId: fgLocation.id,
      role: 'SELLABLE',
      isSellable: true
    }
  });
  assert.equal(sellableQaRes.res.status, 201);
  const sellableQaLocationId = sellableQaRes.payload.id;

  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      lines: [
        { lineNumber: 1, itemId, locationId: sellableQaLocationId, uom: 'each', quantityDelta: 1, reasonCode: 'test' }
      ]
    }
  });
  assert.equal(adjustmentRes.res.status, 201);
  const adjustmentPost = await apiRequest('POST', `/inventory-adjustments/${adjustmentRes.payload.id}/post`, { token });
  assert.equal(adjustmentPost.res.status, 200);

  const sellableQaAtp = await apiRequest('GET', '/atp/detail', {
    token,
    params: { itemId, locationId: sellableQaLocationId }
  });
  assert.equal(sellableQaAtp.res.status, 200);

  const today = new Date().toISOString().slice(0, 10);
  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId: fgLocation.id,
      receivingLocationId: fgLocation.id,
      expectedDate: today,
      status: 'approved',
      lines: [
        {
          itemId,
          uom: 'each',
          quantityOrdered: 10,
          unitCost: 5,
          currencyCode: 'THB'
        }
      ]
    }
  });
  assert.equal(poRes.res.status, 201);
  const poId = poRes.payload.id;
  const poLineId = poRes.payload.lines[0].id;

  const idempotencyKey = `receipt-${randomUUID()}`;
  const receivedAt = new Date().toISOString();
  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      purchaseOrderId: poId,
      receivedAt,
      lines: [{ purchaseOrderLineId: poLineId, uom: 'each', quantityReceived: 10, unitCost: 5 }]
    }
  });
  let receiptPayload = receiptRes.payload;
  if (receiptRes.res.status !== 201) {
    if (receiptRes.res.status === 409) {
      const existing = await db.query(
        `SELECT id
           FROM purchase_order_receipts
          WHERE tenant_id = $1
            AND idempotency_key = $2
          LIMIT 1`,
        [tenantId, idempotencyKey]
      );
      if (existing.rowCount > 0) {
        const fetchRes = await apiRequest('GET', `/purchase-order-receipts/${existing.rows[0].id}`, { token });
        assert.equal(fetchRes.res.status, 200);
        receiptPayload = fetchRes.payload;
      }
    }
  }
  assert.equal(receiptRes.res.status === 201 ? 201 : receiptPayload?.id ? 201 : receiptRes.res.status, 201, JSON.stringify(receiptRes.payload));
  const receiptId = receiptPayload.id;
  const receiptLineId = receiptPayload.lines[0].id;

  const movementsRes = await apiRequest('GET', '/inventory-movements', {
    token,
    params: { external_ref: `po_receipt:${receiptId}`, limit: 5 }
  });
  assert.equal(movementsRes.res.status, 200);
  assert.ok((movementsRes.payload.data || []).length >= 1);
  const movement = movementsRes.payload.data[0];
  assert.equal(movement.movementType, 'receive');
  assert.equal(movement.status, 'posted');

  const movementLinesRes = await apiRequest('GET', `/inventory-movements/${movement.id}/lines`, { token });
  assert.equal(movementLinesRes.res.status, 200);
  const movementLines = movementLinesRes.payload.data || [];
  const qaLine = movementLines.find((line) => line.locationId === qaLocation.id);
  assert.ok(qaLine, `No movement line for QA location. Lines: ${JSON.stringify(movementLines.map(l => ({ locationId: l.locationId, qty: l.quantityDelta })))}, qaLocation.id: ${qaLocation.id}`);
  assert.ok(Number(qaLine.quantityDelta) > 0);

  const qaSnapshot = await apiRequest('GET', '/inventory-snapshot', {
    token,
    params: { itemId, locationId: qaLocation.id }
  });
  assert.equal(qaSnapshot.res.status, 200, `Snapshot failed: ${JSON.stringify(qaSnapshot.payload)}`);
  assert.ok(Array.isArray(qaSnapshot.payload.data), `Snapshot data not array: ${JSON.stringify(qaSnapshot.payload)}`);
  const qaOnHand = qaSnapshot.payload.data[0]?.onHand ?? 0;
  assert.ok(Math.abs(Number(qaOnHand) - 10) < 1e-6, `QA on-hand expected 10, got ${qaOnHand}`);

  const fgSnapshot = await apiRequest('GET', '/inventory-snapshot', {
    token,
    params: { itemId, locationId: fgLocation.id }
  });
  assert.equal(fgSnapshot.res.status, 200);
  const fgOnHand = fgSnapshot.payload.data?.[0]?.onHand ?? 0;
  assert.ok(Math.abs(Number(fgOnHand)) < 1e-6);

  const atpRes = await apiRequest('GET', '/atp', {
    token,
    params: { itemId }
  });
  assert.equal(atpRes.res.status, 200);
  const atpRows = atpRes.payload.data || [];
  const qaAtp = atpRows.find((row) => row.locationId === qaLocation.id);
  assert.equal(qaAtp, undefined);

  const balanceRes = await db.query(
    `SELECT on_hand
       FROM inventory_balance
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = $4`,
    [tenantId, itemId, qaLocation.id, 'each']
  );
  assert.equal(balanceRes.rowCount, 1);
  assert.ok(Math.abs(Number(balanceRes.rows[0].on_hand) - 10) < 1e-6);

  const costRes1 = await db.query(
    `SELECT COUNT(*) AS count
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND source_type = 'receipt'
        AND source_document_id = $2`,
    [tenantId, receiptLineId]
  );
  assert.equal(Number(costRes1.rows[0].count), 1);

  const receiptRes2 = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      purchaseOrderId: poId,
      receivedAt,
      lines: [{ purchaseOrderLineId: poLineId, uom: 'each', quantityReceived: 10, unitCost: 5 }]
    }
  });
  assert.equal(receiptRes2.res.status, 200);
  assert.equal(receiptRes2.payload.id, receiptId);

  const costRes2 = await db.query(
    `SELECT COUNT(*) AS count
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND source_type = 'receipt'
        AND source_document_id = $2`,
    [tenantId, receiptLineId]
  );
  assert.equal(Number(costRes2.rows[0].count), 1);

  const qcKey = `qc-${Date.now()}`;
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

  const qcRes2 = await apiRequest('POST', '/qc-events', {
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
  assert.equal(qcRes2.res.status, 200);
  assert.equal(qcRes2.payload.id, qcEventId);

  const qcMovementsRes = await apiRequest('GET', '/inventory-movements', {
    token,
    params: { external_ref: `qc_event:${qcEventId}`, limit: 5 }
  });
  assert.equal(qcMovementsRes.res.status, 200);
  assert.ok((qcMovementsRes.payload.data || []).length >= 1, `No QC movements found for qc_event:${qcEventId}`);
  const qcMovement = qcMovementsRes.payload.data[0];
  assert.equal(qcMovement.movementType, 'transfer');

  const qcLinesRes = await apiRequest('GET', `/inventory-movements/${qcMovement.id}/lines`, { token });
  assert.equal(qcLinesRes.res.status, 200);
  const qcLines = qcLinesRes.payload.data || [];
  const qaOut = qcLines.find((line) => line.locationId === qaLocation.id);
  const fgIn = qcLines.find((line) => line.locationId === fgLocation.id);
  assert.ok(qaOut && Number(qaOut.quantityDelta) < 0);
  assert.ok(fgIn && Number(fgIn.quantityDelta) > 0);

  const costRes3 = await db.query(
    `SELECT COUNT(*) AS count
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND source_type = 'receipt'
        AND source_document_id = $2`,
    [tenantId, receiptLineId]
  );
  assert.equal(Number(costRes3.rows[0].count), 1);

  const qaSnapshotAfter = await apiRequest('GET', '/inventory-snapshot', {
    token,
    params: { itemId, locationId: qaLocation.id }
  });
  assert.equal(qaSnapshotAfter.res.status, 200);
  const qaOnHandAfter = qaSnapshotAfter.payload.data?.[0]?.onHand ?? 0;
  assert.ok(Math.abs(Number(qaOnHandAfter)) < 1e-6);

  const fgSnapshotAfter = await apiRequest('GET', '/inventory-snapshot', {
    token,
    params: { itemId, locationId: fgLocation.id }
  });
  assert.equal(fgSnapshotAfter.res.status, 200);
  const fgOnHandAfter = fgSnapshotAfter.payload.data?.[0]?.onHand ?? 0;
  assert.ok(Math.abs(Number(fgOnHandAfter) - 10) < 1e-6);
});
