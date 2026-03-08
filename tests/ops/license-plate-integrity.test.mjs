import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';

async function apiRequest(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await res.json().catch(() => null)
    : await res.text().catch(() => '');
  return { res, payload };
}

async function createVendor(token) {
  const code = `LPN-V-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/vendors', {
    token,
    body: { code, name: `Vendor ${code}` }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createItem(token, defaultLocationId) {
  const sku = `LPN-ITEM-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createReceipt({ token, vendorId, itemId, locationId, quantity, unitCost }) {
  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId: locationId,
      receivingLocationId: locationId,
      expectedDate: new Date().toISOString().slice(0, 10),
      status: 'approved',
      lines: [{ itemId, uom: 'each', quantityOrdered: quantity, unitCost, currencyCode: 'THB' }]
    }
  });
  assert.equal(poRes.res.status, 201, JSON.stringify(poRes.payload));

  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `lpn-receipt-${randomUUID()}` },
    body: {
      purchaseOrderId: poRes.payload.id,
      receivedAt: new Date().toISOString(),
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

async function qcAccept(token, receiptLineId, quantity, actorId) {
  const res = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': `lpn-qc-${randomUUID()}` },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity,
      uom: 'each',
      actorType: 'user',
      actorId
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
}

test('license plate move replay detects movement-link corruption', async () => {
  const tenantSlug = `lpn-integrity-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'License Plate Integrity Tenant'
  });
  const token = session.accessToken;
  const db = session.pool;
  const tenantId = session.tenant.id;
  const actorId = session.user?.id ?? null;

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const itemId = await createItem(token, defaults.SELLABLE.id);
  const receiptLineId = await createReceipt({
    token,
    vendorId,
    itemId,
    locationId: defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 3
  });
  await qcAccept(token, receiptLineId, 5, actorId);

  const createLpnRes = await apiRequest('POST', '/lpns', {
    token,
    body: {
      lpn: `LPN-${randomUUID().slice(0, 8)}`,
      itemId,
      locationId: defaults.SELLABLE.id,
      quantity: 5,
      uom: 'each'
    }
  });
  assert.equal(createLpnRes.res.status, 201, JSON.stringify(createLpnRes.payload));
  const licensePlateId = createLpnRes.payload.data.id;

  const idempotencyKey = `lpn-move-${randomUUID()}`;
  const moveRes = await apiRequest('POST', `/lpns/${licensePlateId}/move`, {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      fromLocationId: defaults.SELLABLE.id,
      toLocationId: defaults.QA.id,
      notes: 'Integrity replay move'
    }
  });
  assert.equal(moveRes.res.status, 200, JSON.stringify(moveRes.payload));

  const movementRes = await db.query(
    `SELECT id
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = 'lpn_move'
        AND idempotency_key = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [tenantId, idempotencyKey]
  );
  assert.equal(movementRes.rowCount, 1);
  const movementId = movementRes.rows[0].id;

  const lineRes = await db.query(
    `SELECT id
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [tenantId, movementId]
  );
  assert.equal(lineRes.rowCount, 1);

  await db.query(
    `INSERT INTO inventory_movement_lpns (
        id,
        tenant_id,
        inventory_movement_line_id,
        license_plate_id,
        quantity_delta
      ) VALUES ($1, $2, $3, $4, 1)`,
    [randomUUID(), tenantId, lineRes.rows[0].id, licensePlateId]
  );

  const replay = await apiRequest('POST', `/lpns/${licensePlateId}/move`, {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      fromLocationId: defaults.SELLABLE.id,
      toLocationId: defaults.QA.id,
      notes: 'Integrity replay move'
    }
  });
  assert.equal(replay.res.status, 409, JSON.stringify(replay.payload));
  assert.equal(replay.payload?.error?.code, 'LICENSE_PLATE_INTEGRITY_FAILED');
});
