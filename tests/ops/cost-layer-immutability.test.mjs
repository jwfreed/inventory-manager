import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import { stopTestServer } from '../api/helpers/testServer.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `cost-layer-immut-${randomUUID().slice(0, 8)}`;

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

async function getSession() {
  return ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Cost Layer Immutability Tenant'
  });
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
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createReceipt({ token, vendorId, itemId, sellableLocationId, quantity, unitCost }) {
  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId: sellableLocationId,
      receivingLocationId: sellableLocationId,
      expectedDate: new Date().toISOString().slice(0, 10),
      status: 'approved',
      lines: [{ itemId, uom: 'each', quantityOrdered: quantity, unitCost, currencyCode: 'THB' }]
    }
  });
  assert.equal(poRes.res.status, 201, JSON.stringify(poRes.payload));

  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `receipt-${randomUUID()}` },
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
  return receiptRes.payload;
}

async function qcAccept(token, receiptLineId, quantity, actorId) {
  const res = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': `qc-${randomUUID()}` },
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
  return res.payload.id;
}

async function expectSqlException(queryPromise, code) {
  await assert.rejects(
    queryPromise,
    (error) => {
      assert.match(String(error?.message ?? ''), new RegExp(code));
      return true;
    }
  );
}

test('inventory_cost_layers unit_cost and immutable fields cannot be mutated after insert', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const sellable = defaults.SELLABLE;

  const itemId = await createItem(token, sellable.id);
  const layerId = randomUUID();
  const createdAt = new Date().toISOString();

  await db.query(
    `INSERT INTO inventory_cost_layers (
       id,
       tenant_id,
       item_id,
       location_id,
       uom,
       layer_date,
       layer_sequence,
       original_quantity,
       remaining_quantity,
       unit_cost,
       extended_cost,
       source_type,
       notes,
       created_at,
       updated_at
     ) VALUES ($1,$2,$3,$4,'each',$5,1,10,10,5,50,'adjustment','seed',$6,$6)`,
    [layerId, tenantId, itemId, sellable.id, createdAt, createdAt]
  );

  await expectSqlException(
    db.query(
      `UPDATE inventory_cost_layers
          SET unit_cost = unit_cost + 1,
              updated_at = now()
        WHERE id = $1`,
      [layerId]
    ),
    'COST_LAYER_UNIT_COST_IMMUTABLE'
  );

  await expectSqlException(
    db.query(
      `UPDATE inventory_cost_layers
          SET item_id = $2,
              updated_at = now()
        WHERE id = $1`,
      [layerId, randomUUID()]
    ),
    'COST_LAYER_IMMUTABLE_FIELD_UPDATE'
  );

  await db.query(
    `UPDATE inventory_cost_layers
        SET remaining_quantity = 7,
            extended_cost = 35,
            notes = 'remaining adjusted',
            updated_at = now()
      WHERE id = $1`,
    [layerId]
  );

  const voidedAt = new Date().toISOString();
  await db.query(
    `UPDATE inventory_cost_layers
        SET voided_at = $2,
            void_reason = 'manual_void',
            updated_at = $2
      WHERE id = $1`,
    [layerId, voidedAt]
  );

  await expectSqlException(
    db.query(
      `UPDATE inventory_cost_layers
          SET voided_at = NULL,
              updated_at = now()
        WHERE id = $1`,
      [layerId]
    ),
    'COST_LAYER_UNVOID_NOT_ALLOWED'
  );

  await expectSqlException(
    db.query(
      `UPDATE inventory_cost_layers
          SET remaining_quantity = 6,
              extended_cost = 30,
              updated_at = now()
        WHERE id = $1`,
      [layerId]
    ),
    'COST_LAYER_VOIDED_IMMUTABLE'
  );
});

test('cost_layer_transfer_links blocks item/location/tenant mismatches with deterministic error', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  const actorId = session.user?.id ?? null;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:link-mismatch` });
  const sellable = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const itemA = await createItem(token, sellable.id);
  const itemB = await createItem(token, sellable.id);

  const receipt = await createReceipt({
    token,
    vendorId,
    itemId: itemA,
    sellableLocationId: sellable.id,
    quantity: 5,
    unitCost: 4
  });
  const qcEventId = await qcAccept(token, receipt.lines[0].id, 5, actorId);
  const movementRes = await db.query(
    `SELECT inventory_movement_id
       FROM qc_inventory_links
      WHERE tenant_id = $1
        AND qc_event_id = $2`,
    [tenantId, qcEventId]
  );
  assert.equal(movementRes.rowCount, 1);
  const transferMovementId = movementRes.rows[0].inventory_movement_id;

  const lineRes = await db.query(
    `SELECT id, item_id, location_id, COALESCE(quantity_delta_canonical, quantity_delta) AS qty, COALESCE(canonical_uom, uom) AS uom
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
      ORDER BY qty ASC`,
    [tenantId, transferMovementId]
  );
  assert.equal(lineRes.rowCount, 2);
  const outLine = lineRes.rows[0];
  const inLine = lineRes.rows[1];
  assert.equal(outLine.item_id, itemA);
  assert.equal(inLine.item_id, itemA);

  const mismatchSourceLayerId = randomUUID();
  const extraDestLayerId = randomUUID();
  const timestamp = new Date().toISOString();
  await db.query(
    `INSERT INTO inventory_cost_layers (
       id,
       tenant_id,
       item_id,
       location_id,
       uom,
       layer_date,
       layer_sequence,
       original_quantity,
       remaining_quantity,
       unit_cost,
       extended_cost,
       source_type,
       notes,
       created_at,
       updated_at
     ) VALUES
       ($1,$2,$3,$4,$5,$6,1,2,2,4,8,'adjustment','mismatch source',$6,$6),
       ($7,$2,$8,$9,$5,$6,2,2,2,4,8,'adjustment','extra dest',$6,$6)`,
    [
      mismatchSourceLayerId,
      tenantId,
      itemB,
      outLine.location_id,
      outLine.uom,
      timestamp,
      extraDestLayerId,
      itemA,
      inLine.location_id
    ]
  );

  await expectSqlException(
    db.query(
      `INSERT INTO cost_layer_transfer_links (
         id,
         tenant_id,
         transfer_movement_id,
         transfer_out_line_id,
         transfer_in_line_id,
         source_cost_layer_id,
         dest_cost_layer_id,
         quantity,
         unit_cost,
         extended_cost,
         created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,4,4,$8)`,
      [
        randomUUID(),
        tenantId,
        transferMovementId,
        outLine.id,
        inLine.id,
        mismatchSourceLayerId,
        extraDestLayerId,
        timestamp
      ]
    ),
    'TRANSFER_COST_LINK_DIMENSION_MISMATCH'
  );
});

test.after(async () => {
  await stopTestServer();
});
