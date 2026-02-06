import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = process.env.SEED_TENANT_SLUG || 'default';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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

async function ensureSession() {
  const bootstrapBody = { adminEmail, adminPassword, tenantSlug, tenantName: 'QC Test Tenant' };
  const bootstrap = await apiRequest('POST', '/auth/bootstrap', { body: bootstrapBody });
  if (bootstrap.res.ok) return bootstrap.payload;
  assertOk(bootstrap.res, 'POST /auth/bootstrap', bootstrap.payload, bootstrapBody, [200, 201, 409]);
  const loginBody = { email: adminEmail, password: adminPassword, tenantSlug };
  const login = await apiRequest('POST', '/auth/login', { body: loginBody });
  assertOk(login.res, 'POST /auth/login', login.payload, loginBody, [200]);
  return login.payload;
}

async function ensureWarehouseWithDefaults(token, tenantId) {
  const locationsRes = await apiRequest('GET', '/locations', { token, params: { limit: 200 } });
  assert.equal(locationsRes.res.status, 200);
  let locations = locationsRes.payload.data || [];
  let warehouse = locations.find((loc) => loc.type === 'warehouse');
  if (!warehouse) {
    const code = `WH-${randomUUID()}`;
    const body = {
      code,
      name: `Warehouse ${code}`,
      type: 'warehouse',
      role: 'SELLABLE',
      isSellable: true,
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
    await pool.query(
      `INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [tenantId, warehouse.id, role, loc.id]
    );
    return loc;
  };
  await ensureRole('SELLABLE');
  await ensureRole('QA');
  await ensureRole('HOLD');
  await ensureRole('REJECT');
  const defaultsRes = await pool.query(
    `SELECT role, location_id FROM warehouse_default_location WHERE tenant_id = $1 AND warehouse_id = $2`,
    [tenantId, warehouse.id]
  );
  const defaults = new Map(defaultsRes.rows.map((row) => [row.role, row.location_id]));
  const qaLocationId = defaults.get('QA');
  const sellableLocationId = defaults.get('SELLABLE');
  const qaLocation = locations.find((loc) => loc.id === qaLocationId);
  const sellableLocation = locations.find((loc) => loc.id === sellableLocationId);
  const byId = new Map(locations.map((loc) => [loc.id, loc]));
  const diagnostics = {
    warehouseId: warehouse.id,
    warehouse: formatLocation(warehouse),
    qaLocation: formatLocation(qaLocation),
    sellableLocation: formatLocation(sellableLocation),
    locations: locations.map(formatLocation),
    defaults: defaultsRes.rows
  };
  if (warehouse.parentLocationId !== null || warehouse.type !== 'warehouse') {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID root\n${safeJson(diagnostics)}`);
  }
  if (!qaLocation?.parentLocationId || !isDescendant(qaLocation, warehouse.id, byId)) {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID qa\n${safeJson(diagnostics)}`);
  }
  if (!sellableLocation?.parentLocationId || !isDescendant(sellableLocation, warehouse.id, byId)) {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID sellable\n${safeJson(diagnostics)}`);
  }
}

test('QC accept is idempotent and creates no cost layers', async () => {
  const session = await ensureSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const userId = session.user?.id;
  assert.ok(token);
  assert.ok(tenantId);

  // Setup warehouse with QA and SELLABLE locations
  await ensureWarehouseWithDefaults(token, tenantId);

  const locationsRes = await apiRequest('GET', '/locations', { token });
  assert.equal(locationsRes.res.status, 200);
  const qaLocation = locationsRes.payload.data.find(l => l.role === 'QA');
  const warehouse = locationsRes.payload.data.find(l => l.type === 'warehouse');
  assert.ok(qaLocation, 'QA location required');
  assert.ok(warehouse, 'Warehouse required');

  // Find the actual SELLABLE default for this warehouse (what QC will use)
  const defaultsRes = await pool.query(
    `SELECT location_id FROM warehouse_default_location WHERE tenant_id = $1 AND warehouse_id = $2 AND role = 'SELLABLE'`,
    [tenantId, warehouse.id]
  );
  assert.equal(defaultsRes.rowCount, 1, 'SELLABLE default required');
  const sellableLocationId = defaultsRes.rows[0].location_id;

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

  // Verify QA has stock
  const qaBalanceBefore = await pool.query(
    `SELECT on_hand FROM inventory_balance WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4`,
    [tenantId, itemId, qaLocation.id, 'each']
  );
  assert.equal(qaBalanceBefore.rowCount, 1);
  assert.ok(Math.abs(Number(qaBalanceBefore.rows[0].on_hand) - 10) < 1e-6);

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

  // Verify only one transfer movement via qc_inventory_links
  const linksResult = await pool.query(
    `SELECT inventory_movement_id FROM qc_inventory_links WHERE tenant_id = $1 AND qc_event_id = $2`,
    [tenantId, qcEventId]
  );
  assert.equal(linksResult.rowCount, 1, 'Should have exactly one transfer movement');
  const movementId = linksResult.rows[0].inventory_movement_id;

  // Verify it's a transfer
  const movementResult = await pool.query(
    `SELECT movement_type, status FROM inventory_movements WHERE id = $1`,
    [movementId]
  );
  assert.equal(movementResult.rows[0].movement_type, 'transfer');
  assert.equal(movementResult.rows[0].status, 'posted');

  // Verify QA is 0, SELLABLE is 10
  const qaBalanceAfter = await pool.query(
    `SELECT on_hand FROM inventory_balance WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4`,
    [tenantId, itemId, qaLocation.id, 'each']
  );
  assert.equal(qaBalanceAfter.rowCount, 1);
  assert.ok(Math.abs(Number(qaBalanceAfter.rows[0].on_hand)) < 1e-6);

  const sellableBalance = await pool.query(
    `SELECT on_hand FROM inventory_balance WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4`,
    [tenantId, itemId, sellableLocationId, 'each']
  );
  assert.equal(sellableBalance.rowCount, 1);
  assert.ok(Math.abs(Number(sellableBalance.rows[0].on_hand) - 10) < 1e-6);
});

test('QC partial split: accept + hold', async () => {
  const session = await ensureSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const userId = session.user?.id;
  assert.ok(token);

  await ensureWarehouseWithDefaults(token, tenantId);

  const locationsRes = await apiRequest('GET', '/locations', { token });
  const warehouse = locationsRes.payload.data.find(l => l.type === 'warehouse');
  assert.ok(warehouse);

  const defaultsRes = await pool.query(
    `SELECT role, location_id
       FROM warehouse_default_location
      WHERE tenant_id = $1 AND warehouse_id = $2 AND role IN ('SELLABLE','QA','HOLD')`,
    [tenantId, warehouse.id]
  );
  const defaults = new Map(defaultsRes.rows.map((row) => [row.role, row.location_id]));
  const qaLocationId = defaults.get('QA');
  const holdLocationId = defaults.get('HOLD');
  const sellableLocationId = defaults.get('SELLABLE');
  assert.ok(qaLocationId && holdLocationId && sellableLocationId);

  const qaLocation = locationsRes.payload.data.find(l => l.id === qaLocationId);
  const holdLocation = locationsRes.payload.data.find(l => l.id === holdLocationId);
  assert.ok(qaLocation && holdLocation);

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
  const qaBalance = await pool.query(
    `SELECT on_hand FROM inventory_balance WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4`,
    [tenantId, itemId, qaLocation.id, 'each']
  );
  assert.ok(Math.abs(Number(qaBalance.rows[0]?.on_hand ?? 0)) < 1e-6, 'QA should be empty');

  const sellableBalance = await pool.query(
    `SELECT on_hand FROM inventory_balance WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4`,
    [tenantId, itemId, sellableLocationId, 'each']
  );
  assert.ok(Math.abs(Number(sellableBalance.rows[0]?.on_hand ?? 0) - 6) < 1e-6, 'SELLABLE should be 6');

  const holdBalance = await pool.query(
    `SELECT on_hand FROM inventory_balance WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4`,
    [tenantId, itemId, holdLocation.id, 'each']
  );
  assert.ok(Math.abs(Number(holdBalance.rows[0]?.on_hand ?? 0) - 4) < 1e-6, 'HOLD should be 4');

  // Verify two transfer movements via qc_inventory_links
  const acceptLinks = await pool.query(
    `SELECT inventory_movement_id FROM qc_inventory_links WHERE tenant_id = $1 AND qc_event_id = $2`,
    [tenantId, qcAcceptRes.payload.id]
  );
  assert.equal(acceptLinks.rowCount, 1, 'Accept should have one movement');

  const holdLinks = await pool.query(
    `SELECT inventory_movement_id FROM qc_inventory_links WHERE tenant_id = $1 AND qc_event_id = $2`,
    [tenantId, qcHoldRes.payload.id]
  );
  assert.equal(holdLinks.rowCount, 1, 'Hold should have one movement');
});

test('QC validation: qty exceeds QA on-hand', async (t) => {
  t.after(async () => {
    await pool.end();
  });

  const session = await ensureSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);

  await ensureWarehouseWithDefaults(token, tenantId);

  const locationsRes = await apiRequest('GET', '/locations', { token });
  const qaLocation = locationsRes.payload.data.find(l => l.role === 'QA');
  const warehouse = locationsRes.payload.data.find(l => l.type === 'warehouse');
  assert.ok(qaLocation && warehouse);

  // Find the actual SELLABLE default for this warehouse
  const defaultsRes = await pool.query(
    `SELECT location_id FROM warehouse_default_location WHERE tenant_id = $1 AND warehouse_id = $2 AND role = 'SELLABLE'`,
    [tenantId, warehouse.id]
  );
  assert.equal(defaultsRes.rowCount, 1, 'SELLABLE default required');
  const sellableLocationId = defaultsRes.rows[0].location_id;

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
