import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import { insertPostedMovementFixture } from '../helpers/movementFixture.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  loadReplenishmentPositionBatch,
  buildReplenishmentScopeKey
} = require('../../src/services/replenishmentPosition.service.ts');
const { getDerivedBackorderBatch } = require('../../src/services/backorderDerivation.service.ts');
const { computeInventoryPosition } = require('../../src/services/replenishmentMath.ts');

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

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
  const res = await apiRequest('POST', '/vendors', {
    token,
    body: { code: `V-${randomUUID().slice(0, 8)}`, name: `Vendor ${Date.now()}` }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createCustomer(pool, tenantId) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, code, name, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, now(), now())`,
    [id, tenantId, `C-${randomUUID().slice(0, 8)}`, `Customer ${Date.now()}`]
  );
  return id;
}

async function createItem(token, locationId, suffix) {
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `RPL-${suffix}`,
      name: `Replenishment ${suffix}`,
      type: 'raw',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: locationId,
      active: true
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function seedPostedOnHand(pool, { tenantId, itemId, locationId, quantity }) {
  const now = new Date().toISOString();
  await insertPostedMovementFixture(pool, {
    tenantId,
    movementType: 'adjustment',
    occurredAt: now,
    externalRef: `repl-batch:${randomUUID()}`,
    notes: 'replenishment batch seed',
    lines: [
      {
        itemId,
        locationId,
        quantityDelta: quantity,
        uom: 'each',
        quantityDeltaEntered: quantity,
        uomEntered: 'each',
        quantityDeltaCanonical: quantity,
        canonicalUom: 'each',
        uomDimension: 'count',
        reasonCode: 'seed',
        lineNotes: 'seed',
        createdAt: now
      }
    ]
  });
}

async function createSalesOrder(token, customerId, warehouseId, shipFromLocationId, itemId, quantityOrdered) {
  const res = await apiRequest('POST', '/sales-orders', {
    token,
    body: {
      soNumber: `SO-${randomUUID().slice(0, 8)}`,
      customerId,
      warehouseId,
      shipFromLocationId,
      status: 'submitted',
      lines: [{ itemId, uom: 'each', quantityOrdered }]
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return { orderId: res.payload.id, lineId: res.payload.lines[0].id };
}

async function createReservation(token, warehouseId, locationId, lineId, itemId, quantityReserved) {
  const res = await apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `res-${randomUUID()}` },
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: lineId,
          itemId,
          warehouseId,
          locationId,
          uom: 'each',
          quantityReserved
        }
      ]
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
}

async function createApprovedPoAndReceipt(token, vendorId, locationId, itemId, orderedQty, receivedQty) {
  const today = new Date().toISOString().slice(0, 10);
  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId: locationId,
      receivingLocationId: locationId,
      expectedDate: today,
      status: 'approved',
      lines: [{ itemId, uom: 'each', quantityOrdered: orderedQty, unitCost: 5, currencyCode: 'THB' }]
    }
  });
  assert.equal(poRes.res.status, 201, JSON.stringify(poRes.payload));

  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `rcpt-${randomUUID()}` },
    body: {
      purchaseOrderId: poRes.payload.id,
      receivedAt: new Date().toISOString(),
      lines: [
        {
          purchaseOrderLineId: poRes.payload.lines[0].id,
          uom: 'each',
          quantityReceived: receivedQty,
          unitCost: 5
        }
      ]
    }
  });
  assert.equal(receiptRes.res.status, 201, JSON.stringify(receiptRes.payload));
  return receiptRes.payload.lines[0].id;
}

test('replenishment position batch uses one usable-supply definition and scope-aligned inbound math', async () => {
  const session = await ensureDbSession({
    apiRequest,
    tenantSlug: `repl-batch-${randomUUID().slice(0, 8)}`,
    tenantName: 'Replenishment Batch Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({
    token,
    apiRequest,
    scope: import.meta.url
  });
  const sellable = defaults.SELLABLE;
  const itemId = await createItem(token, sellable.id, randomUUID().slice(0, 8));
  const customerId = await createCustomer(session.pool, tenantId);
  const vendorId = await createVendor(token);

  await seedPostedOnHand(session.pool, { tenantId, itemId, locationId: sellable.id, quantity: 20 });
  const { lineId } = await createSalesOrder(token, customerId, warehouse.id, sellable.id, itemId, 25);
  await createReservation(token, warehouse.id, sellable.id, lineId, itemId, 3);

  await createApprovedPoAndReceipt(token, vendorId, sellable.id, itemId, 15, 8);

  const keys = [{ warehouseId: warehouse.id, itemId, locationId: sellable.id, uom: 'each' }];
  const batch = await loadReplenishmentPositionBatch(tenantId, keys);
  const scopeKey = buildReplenishmentScopeKey(tenantId, keys[0]);
  const position = batch.positionByScope.get(scopeKey);
  assert.ok(position);

  assert.equal(position.onHand, 20);
  assert.equal(position.usableOnHand, 20);
  assert.equal(position.reservedCommitment, 3);
  assert.equal(position.onOrder, 7);
  assert.equal(position.inTransit, 0);
  assert.equal(position.openPurchaseSupply, 7);
  assert.equal(position.acceptedPendingPutawaySupply, 0);
  assert.equal(position.qaHeldSupply, 0);
  assert.equal(position.rejectedSupply, 0);
  assert.equal(position.transferInboundSupply, 0);

  const derivedBackorders = await getDerivedBackorderBatch({
    tenantId,
    keys,
    usableSupplyByScope: batch.usableSupplyByScope,
    inboundSupplyByScope: batch.inboundSupplyByScope
  });
  assert.equal(derivedBackorders.get(scopeKey), 0);

  const inventoryPosition = computeInventoryPosition({
    usableOnHand: position.usableOnHand,
    onOrder: position.onOrder,
    inTransit: position.inTransit,
    reservedCommitment: position.reservedCommitment,
    backorderedQty: derivedBackorders.get(scopeKey) ?? 0
  });
  assert.equal(inventoryPosition, 24);

  await seedPostedOnHand(session.pool, { tenantId, itemId, locationId: sellable.id, quantity: 5 });
  const batchAfterSupply = await loadReplenishmentPositionBatch(tenantId, keys);
  const derivedAfterSupply = await getDerivedBackorderBatch({
    tenantId,
    keys,
    usableSupplyByScope: batchAfterSupply.usableSupplyByScope,
    inboundSupplyByScope: batchAfterSupply.inboundSupplyByScope
  });
  assert.equal(derivedAfterSupply.get(scopeKey), 0);
});
