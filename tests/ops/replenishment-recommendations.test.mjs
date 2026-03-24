import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import { insertPostedMovementFixture } from '../helpers/movementFixture.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const require = createRequire(import.meta.url);

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

async function createItem(token, locationId, suffix) {
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `RPL-OPS-${suffix}`,
      name: `Replenishment Ops ${suffix}`,
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
    externalRef: `repl-ops:${randomUUID()}`,
    notes: 'replenishment ops seed',
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

async function createCustomer(pool, tenantId) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, code, name, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, now(), now())`,
    [id, tenantId, `C-${randomUUID().slice(0, 8)}`, `Customer ${Date.now()}`]
  );
  return id;
}

async function createVendor(token) {
  const res = await apiRequest('POST', '/vendors', {
    token,
    body: {
      code: `V-${randomUUID().slice(0, 8)}`,
      name: `Vendor ${Date.now()}`
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
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

async function createApprovedPurchaseOrder(token, vendorId, locationId, itemId, quantityOrdered) {
  const res = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId: locationId,
      receivingLocationId: locationId,
      expectedDate: new Date().toISOString().slice(0, 10),
      status: 'approved',
      lines: [
        {
          itemId,
          uom: 'each',
          quantityOrdered,
          unitCost: 5,
          currencyCode: 'THB'
        }
      ]
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload;
}

async function createPolicy(token, body, expectedStatus = 201) {
  const res = await apiRequest('POST', '/replenishment/policies', { token, body });
  assert.equal(res.res.status, expectedStatus, JSON.stringify(res.payload));
  return res;
}

function findRecommendation(payload, policyId) {
  return payload.data.find((row) => row.policyId === policyId);
}

test('replenishment policy validation rejects invalid write combinations', async () => {
  const session = await ensureDbSession({
    apiRequest,
    tenantSlug: `repl-ops-invalid-${randomUUID().slice(0, 8)}`,
    tenantName: 'Replenishment Invalid Policy Tenant'
  });
  const token = session.accessToken;
  assert.ok(token);

  const { defaults } = await ensureStandardWarehouse({
    token,
    apiRequest,
    scope: `${import.meta.url}:invalid`
  });
  const itemId = await createItem(token, defaults.SELLABLE.id, randomUUID().slice(0, 8));

  await createPolicy(
    token,
    {
      itemId,
      uom: 'each',
      siteLocationId: defaults.SELLABLE.id,
      policyType: 'q_rop',
      safetyStockMethod: 'none',
      reorderPointQty: 5
    },
    400
  );

  await createPolicy(
    token,
    {
      itemId,
      uom: 'each',
      siteLocationId: defaults.SELLABLE.id,
      policyType: 'min_max',
      safetyStockMethod: 'none',
      reorderPointQty: 10,
      orderUpToLevelQty: 5
    },
    400
  );
});

test('replenishment recommendations use canonical math, explicit precedence, and structured statuses', async () => {
  const session = await ensureDbSession({
    apiRequest,
    tenantSlug: `repl-ops-${randomUUID().slice(0, 8)}`,
    tenantName: 'Replenishment Recommendations Tenant'
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
  const locationId = defaults.SELLABLE.id;
  const customerId = await createCustomer(session.pool, tenantId);

  const qropItemId = await createItem(token, locationId, `qrop-${randomUUID().slice(0, 6)}`);
  await seedPostedOnHand(session.pool, { tenantId, itemId: qropItemId, locationId, quantity: 10 });
  const qropPolicy = await createPolicy(token, {
    itemId: qropItemId,
    uom: 'each',
    siteLocationId: locationId,
    policyType: 'q_rop',
    safetyStockMethod: 'none',
    reorderPointQty: 10,
    orderQuantityQty: 6
  });

  const minMaxExplicitItemId = await createItem(token, locationId, `mm-exp-${randomUUID().slice(0, 6)}`);
  await seedPostedOnHand(session.pool, { tenantId, itemId: minMaxExplicitItemId, locationId, quantity: 7 });
  const explicitOrder = await createSalesOrder(token, customerId, warehouse.id, locationId, minMaxExplicitItemId, 7);
  await createReservation(token, warehouse.id, locationId, explicitOrder.lineId, minMaxExplicitItemId, 1);
  const minMaxExplicitPolicy = await createPolicy(token, {
    itemId: minMaxExplicitItemId,
    uom: 'each',
    siteLocationId: locationId,
    policyType: 'min_max',
    safetyStockMethod: 'fixed',
    safetyStockQty: 2,
    leadTimeDays: 2,
    demandRatePerDay: 5,
    reorderPointQty: 5,
    orderUpToLevelQty: 20
  });

  const minMaxDerivedItemId = await createItem(token, locationId, `mm-der-${randomUUID().slice(0, 6)}`);
  await seedPostedOnHand(session.pool, { tenantId, itemId: minMaxDerivedItemId, locationId, quantity: 8 });
  const minMaxDerivedPolicy = await createPolicy(token, {
    itemId: minMaxDerivedItemId,
    uom: 'each',
    siteLocationId: locationId,
    policyType: 't_oul',
    safetyStockMethod: 'fixed',
    safetyStockQty: 4,
    leadTimeDays: 2,
    demandRatePerDay: 3,
    orderUpToLevelQty: 20
  });

  const ppisItemId = await createItem(token, locationId, `ppis-${randomUUID().slice(0, 6)}`);
  await seedPostedOnHand(session.pool, { tenantId, itemId: ppisItemId, locationId, quantity: 7 });
  const ppisPolicy = await createPolicy(token, {
    itemId: ppisItemId,
    uom: 'each',
    siteLocationId: locationId,
    policyType: 'q_rop',
    safetyStockMethod: 'ppis',
    ppisPeriods: 10,
    leadTimeDays: 2,
    demandRatePerDay: 3,
    orderQuantityQty: 4
  });

  const invalidItemId = await createItem(token, locationId, `inv-${randomUUID().slice(0, 6)}`);
  await session.pool.query(
    `INSERT INTO replenishment_policies (
      id, tenant_id, item_id, uom, site_location_id, policy_type, status, safety_stock_method, created_at, updated_at
    ) VALUES ($1, $2, $3, 'each', $4, 'q_rop', 'active', 'none', now(), now())`,
    [randomUUID(), tenantId, invalidItemId, locationId]
  );
  const invalidPolicyId = (
    await session.pool.query(
      `SELECT id
         FROM replenishment_policies
        WHERE tenant_id = $1
          AND item_id = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, invalidItemId]
    )
  ).rows[0].id;

  const negativeItemId = await createItem(token, locationId, `neg-${randomUUID().slice(0, 6)}`);
  const negativePolicy = await createPolicy(token, {
    itemId: negativeItemId,
    uom: 'each',
    siteLocationId: locationId,
    policyType: 'q_rop',
    safetyStockMethod: 'none',
    reorderPointQty: 10,
    orderQuantityQty: 4
  });
  await createSalesOrder(token, customerId, warehouse.id, locationId, negativeItemId, 100);

  const recsRes = await apiRequest('GET', '/replenishment/recommendations', { token, params: { limit: 50, offset: 0 } });
  assert.equal(recsRes.res.status, 200, JSON.stringify(recsRes.payload));

  const qropRec = findRecommendation(recsRes.payload, qropPolicy.payload.id);
  assert.equal(qropRec.normalizedPolicyType, 'q_rop');
  assert.equal(qropRec.status, 'actionable');
  assert.equal(qropRec.recommendation.reorderNeeded, true);
  assert.equal(qropRec.inventory.usableOnHand, 10);
  assert.equal(qropRec.inventory.inventoryPosition, 10);
  assert.equal(qropRec.inputs.effectiveReorderPointQty, 10);
  assert.equal(qropRec.recommendation.recommendedOrderQty, 6);

  const minMaxExplicitRec = findRecommendation(recsRes.payload, minMaxExplicitPolicy.payload.id);
  assert.equal(minMaxExplicitRec.normalizedPolicyType, 'min_max');
  assert.equal(minMaxExplicitRec.inputs.reorderPointSource, 'explicit');
  assert.equal(minMaxExplicitRec.inputs.effectiveReorderPointQty, 5);
  assert.equal(minMaxExplicitRec.inventory.reserved, 1);
  assert.equal(minMaxExplicitRec.inventory.inventoryPosition, 6);
  assert.equal(minMaxExplicitRec.status, 'not_needed');
  assert.equal(minMaxExplicitRec.recommendation.recommendedOrderQty, 0);

  const minMaxDerivedRec = findRecommendation(recsRes.payload, minMaxDerivedPolicy.payload.id);
  assert.equal(minMaxDerivedRec.normalizedPolicyType, 'min_max');
  assert.equal(minMaxDerivedRec.inputs.reorderPointSource, 'derived');
  assert.equal(minMaxDerivedRec.inputs.effectiveSafetyStockQty, 4);
  assert.equal(minMaxDerivedRec.inputs.effectiveReorderPointQty, 10);
  assert.equal(minMaxDerivedRec.status, 'actionable');
  assert.equal(minMaxDerivedRec.recommendation.recommendedOrderQty, 12);

  const ppisRec = findRecommendation(recsRes.payload, ppisPolicy.payload.id);
  assert.equal(ppisRec.inputs.cycleCoverageQty, 30);
  assert.equal(ppisRec.inputs.effectiveSafetyStockQty, 0);
  assert.equal(ppisRec.inputs.effectiveReorderPointQty, 6);
  assert.equal(ppisRec.status, 'not_needed');
  assert.equal(ppisRec.recommendation.recommendedOrderQty, 0);

  const invalidRec = findRecommendation(recsRes.payload, invalidPolicyId);
  assert.equal(invalidRec.status, 'invalid_policy');
  assert.ok(Array.isArray(invalidRec.validationErrors));
  assert.ok(invalidRec.validationErrors.length > 0);

  const negativeRec = findRecommendation(recsRes.payload, negativePolicy.payload.id);
  assert.equal(negativeRec.status, 'actionable');
  assert.ok(negativeRec.inventory.inventoryPosition < 0);
  assert.equal(negativeRec.recommendation.recommendedOrderQty, 4);
});

test('replenishment recommendations use inbound-aware backorder and avoid demand double counting', async () => {
  const session = await ensureDbSession({
    apiRequest,
    tenantSlug: `repl-ops-inbound-${randomUUID().slice(0, 8)}`,
    tenantName: 'Replenishment Inbound-Aware Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { warehouse, defaults } = await ensureStandardWarehouse({
    token,
    apiRequest,
    scope: `${import.meta.url}:inbound-aware`
  });
  const locationId = defaults.SELLABLE.id;
  const customerId = await createCustomer(session.pool, tenantId);
  const vendorId = await createVendor(token);

  const inboundSatisfiesItemId = await createItem(token, locationId, `full-${randomUUID().slice(0, 6)}`);
  await createSalesOrder(token, customerId, warehouse.id, locationId, inboundSatisfiesItemId, 100);
  await createApprovedPurchaseOrder(token, vendorId, locationId, inboundSatisfiesItemId, 100);
  const inboundSatisfiesPolicy = await createPolicy(token, {
    itemId: inboundSatisfiesItemId,
    uom: 'each',
    siteLocationId: locationId,
    policyType: 'q_rop',
    safetyStockMethod: 'none',
    reorderPointQty: 10,
    orderQuantityQty: 5
  });

  const partialInboundItemId = await createItem(token, locationId, `partial-${randomUUID().slice(0, 6)}`);
  await seedPostedOnHand(session.pool, { tenantId, itemId: partialInboundItemId, locationId, quantity: 20 });
  await createSalesOrder(token, customerId, warehouse.id, locationId, partialInboundItemId, 100);
  await createApprovedPurchaseOrder(token, vendorId, locationId, partialInboundItemId, 50);
  const partialInboundPolicy = await createPolicy(token, {
    itemId: partialInboundItemId,
    uom: 'each',
    siteLocationId: locationId,
    policyType: 'q_rop',
    safetyStockMethod: 'none',
    reorderPointQty: 10,
    orderQuantityQty: 5
  });

  const noInboundItemId = await createItem(token, locationId, `none-${randomUUID().slice(0, 6)}`);
  await seedPostedOnHand(session.pool, { tenantId, itemId: noInboundItemId, locationId, quantity: 20 });
  await createSalesOrder(token, customerId, warehouse.id, locationId, noInboundItemId, 100);
  const noInboundPolicy = await createPolicy(token, {
    itemId: noInboundItemId,
    uom: 'each',
    siteLocationId: locationId,
    policyType: 'q_rop',
    safetyStockMethod: 'none',
    reorderPointQty: 10,
    orderQuantityQty: 5
  });

  const reservedNoOverlapItemId = await createItem(token, locationId, `reserve-${randomUUID().slice(0, 6)}`);
  await seedPostedOnHand(session.pool, { tenantId, itemId: reservedNoOverlapItemId, locationId, quantity: 20 });
  const reservedOrder = await createSalesOrder(
    token,
    customerId,
    warehouse.id,
    locationId,
    reservedNoOverlapItemId,
    20
  );
  await createReservation(token, warehouse.id, locationId, reservedOrder.lineId, reservedNoOverlapItemId, 20);
  const reservedNoOverlapPolicy = await createPolicy(token, {
    itemId: reservedNoOverlapItemId,
    uom: 'each',
    siteLocationId: locationId,
    policyType: 'q_rop',
    safetyStockMethod: 'none',
    reorderPointQty: 1,
    orderQuantityQty: 5
  });

  const recsRes = await apiRequest('GET', '/replenishment/recommendations', { token, params: { limit: 50, offset: 0 } });
  assert.equal(recsRes.res.status, 200, JSON.stringify(recsRes.payload));

  const inboundSatisfiesRec = findRecommendation(recsRes.payload, inboundSatisfiesPolicy.payload.id);
  assert.equal(inboundSatisfiesRec.inventory.usableOnHand, 0);
  assert.equal(inboundSatisfiesRec.inventory.onOrder, 100);
  assert.equal(inboundSatisfiesRec.inventory.backordered, 0);
  assert.equal(inboundSatisfiesRec.inventory.inventoryPosition, 100);

  const partialInboundRec = findRecommendation(recsRes.payload, partialInboundPolicy.payload.id);
  assert.equal(partialInboundRec.inventory.usableOnHand, 20);
  assert.equal(partialInboundRec.inventory.onOrder, 50);
  assert.equal(partialInboundRec.inventory.backordered, 30);
  assert.equal(partialInboundRec.inventory.inventoryPosition, 40);

  const noInboundRec = findRecommendation(recsRes.payload, noInboundPolicy.payload.id);
  assert.equal(noInboundRec.inventory.usableOnHand, 20);
  assert.equal(noInboundRec.inventory.onOrder, 0);
  assert.equal(noInboundRec.inventory.backordered, 80);
  assert.equal(noInboundRec.inventory.inventoryPosition, -60);

  const reservedNoOverlapRec = findRecommendation(recsRes.payload, reservedNoOverlapPolicy.payload.id);
  assert.equal(reservedNoOverlapRec.inventory.usableOnHand, 20);
  assert.equal(reservedNoOverlapRec.inventory.reserved, 20);
  assert.equal(reservedNoOverlapRec.inventory.backordered, 0);
  assert.equal(reservedNoOverlapRec.inventory.inventoryPosition, 0);
});

test('replenishment backorder derivation handles partial inbound correctly', async () => {
  require('ts-node/register/transpile-only');
  require('tsconfig-paths/register');

  const dbModule = require('../../src/db.ts');
  const { getDerivedBackorderBatch } = require('../../src/services/backorderDerivation.service.ts');
  const { buildReplenishmentScopeKey } = require('../../src/services/replenishmentPosition.service.ts');

  const tenantId = `tenant-${randomUUID()}`;
  const key = { warehouseId: 'wh-1', itemId: 'item-1', locationId: 'loc-1', uom: 'each' };
  const scopeKey = buildReplenishmentScopeKey(tenantId, key);

  const originalQuery = dbModule.query;
  let queryCalls = 0;
  dbModule.query = async () => {
    queryCalls += 1;
    if (queryCalls === 1) {
      return {
        rows: [
          {
            warehouse_id: key.warehouseId,
            item_id: key.itemId,
            location_id: key.locationId,
            uom: key.uom,
            ordered_qty: 100
          }
        ],
        rowCount: 1
      };
    }
    if (queryCalls === 2) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected query count ${queryCalls}`);
  };

  try {
    const derived = await getDerivedBackorderBatch({
      tenantId,
      keys: [key],
      usableSupplyByScope: new Map([[scopeKey, { usableOnHand: 20, available: 20, reservedCommitment: 0 }]]),
      inboundSupplyByScope: new Map([[scopeKey, { onOrder: 50, inTransit: 0 }]])
    });
    assert.equal(derived.get(scopeKey), 30);
    assert.equal(queryCalls, 2);
  } finally {
    dbModule.query = originalQuery;
  }
});

test('replenishment backorder derivation stays batched for multiple scopes', async () => {
  require('ts-node/register/transpile-only');
  require('tsconfig-paths/register');

  const dbModule = require('../../src/db.ts');
  const { getDerivedBackorderBatch } = require('../../src/services/backorderDerivation.service.ts');
  const { buildReplenishmentScopeKey } = require('../../src/services/replenishmentPosition.service.ts');

  const tenantId = `tenant-${randomUUID()}`;
  const keys = [
    { warehouseId: 'wh-1', itemId: 'item-1', locationId: 'loc-1', uom: 'each' },
    { warehouseId: 'wh-1', itemId: 'item-2', locationId: 'loc-1', uom: 'each' },
    { warehouseId: 'wh-1', itemId: 'item-3', locationId: 'loc-1', uom: 'each' }
  ];

  const usableSupplyByScope = new Map([
    [buildReplenishmentScopeKey(tenantId, keys[0]), { usableOnHand: 0, available: 0, reservedCommitment: 0 }],
    [buildReplenishmentScopeKey(tenantId, keys[1]), { usableOnHand: 20, available: 20, reservedCommitment: 0 }],
    [buildReplenishmentScopeKey(tenantId, keys[2]), { usableOnHand: 20, available: 20, reservedCommitment: 0 }]
  ]);
  const inboundSupplyByScope = new Map([
    [buildReplenishmentScopeKey(tenantId, keys[0]), { onOrder: 100, inTransit: 0 }],
    [buildReplenishmentScopeKey(tenantId, keys[1]), { onOrder: 50, inTransit: 0 }],
    [buildReplenishmentScopeKey(tenantId, keys[2]), { onOrder: 0, inTransit: 0 }]
  ]);

  const originalQuery = dbModule.query;
  let queryCalls = 0;
  dbModule.query = async (...args) => {
    queryCalls += 1;
    if (queryCalls === 1) {
      return {
        rows: keys.map((key) => ({
          warehouse_id: key.warehouseId,
          item_id: key.itemId,
          location_id: key.locationId,
          uom: key.uom,
          ordered_qty: 100
        })),
        rowCount: keys.length
      };
    }
    if (queryCalls === 2) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected query count ${queryCalls} with args ${JSON.stringify(args[0])}`);
  };

  try {
    const derived = await getDerivedBackorderBatch({
      tenantId,
      keys,
      usableSupplyByScope,
      inboundSupplyByScope
    });

    assert.equal(queryCalls, 2);
    assert.equal(derived.get(buildReplenishmentScopeKey(tenantId, keys[0])), 0);
    assert.equal(derived.get(buildReplenishmentScopeKey(tenantId, keys[1])), 30);
    assert.equal(derived.get(buildReplenishmentScopeKey(tenantId, keys[2])), 80);
  } finally {
    dbModule.query = originalQuery;
  }
});
