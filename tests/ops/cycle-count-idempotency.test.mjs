import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `cycle-count-idem-${randomUUID().slice(0, 8)}`;

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
    tenantName: 'Cycle Count Idempotency Tenant'
  });
}

async function createItem(token, defaultLocationId, skuPrefix) {
  const sku = `${skuPrefix}-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      type: 'finished',
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

async function seedOnHand(token, itemId, locationId, quantity) {
  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      reasonCode: 'seed',
      lines: [
        {
          lineNumber: 1,
          itemId,
          locationId,
          uom: 'each',
          quantityDelta: quantity,
          reasonCode: 'seed'
        }
      ]
    }
  });
  assert.equal(adjustmentRes.res.status, 201, JSON.stringify(adjustmentRes.payload));
  const postRes = await apiRequest('POST', `/inventory-adjustments/${adjustmentRes.payload.id}/post`, {
    token,
    body: {}
  });
  assert.equal(postRes.res.status, 200, JSON.stringify(postRes.payload));
}

function normalizeCountPostPayload(count) {
  const lines = [...(count.lines ?? [])]
    .map((line) => ({
      itemId: line.itemId,
      locationId: line.locationId,
      uom: line.uom,
      countedQuantity: Number(line.countedQuantity),
      unitCostForPositiveAdjustment:
        line.unitCostForPositiveAdjustment !== undefined && line.unitCostForPositiveAdjustment !== null
          ? Number(line.unitCostForPositiveAdjustment)
          : null
    }))
    .sort((a, b) => {
      const location = a.locationId.localeCompare(b.locationId);
      if (location !== 0) return location;
      const item = a.itemId.localeCompare(b.itemId);
      if (item !== 0) return item;
      return a.uom.localeCompare(b.uom);
    });
  return {
    countId: count.id,
    warehouseId: count.warehouseId,
    occurredAt: count.countedAt,
    lines
  };
}

function hashPayload(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

test('cycle count post idempotency: same key+payload replays; different payload conflicts; incomplete is detected', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const db = session.pool;
  const tenantId = session.tenant.id;
  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:idem` });
  const sellable = defaults.SELLABLE;

  const itemId = await createItem(token, sellable.id, 'CC-IDEM');
  await seedOnHand(token, itemId, sellable.id, 5);

  const createRes = await apiRequest('POST', '/inventory-counts', {
    token,
    body: {
      countedAt: new Date().toISOString(),
      warehouseId: warehouse.id,
      lines: [
        {
          lineNumber: 1,
          itemId,
          locationId: sellable.id,
          uom: 'each',
          countedQuantity: 4,
          reasonCode: 'shrink'
        }
      ]
    }
  });
  assert.equal(createRes.res.status, 201, JSON.stringify(createRes.payload));
  const countId = createRes.payload.id;

  const mismatchPost = await apiRequest('POST', `/inventory-counts/${countId}/post`, {
    token,
    headers: { 'Idempotency-Key': `count-post-wh-mismatch-${randomUUID()}` },
    body: { warehouseId: randomUUID() }
  });
  assert.equal(mismatchPost.res.status, 409, JSON.stringify(mismatchPost.payload));
  assert.equal(mismatchPost.payload?.error?.code, 'WAREHOUSE_SCOPE_MISMATCH');

  const idemKey = `count-post-${randomUUID()}`;
  const firstPost = await apiRequest('POST', `/inventory-counts/${countId}/post`, {
    token,
    headers: { 'Idempotency-Key': idemKey },
    body: {}
  });
  assert.equal(firstPost.res.status, 200, JSON.stringify(firstPost.payload));
  const secondPost = await apiRequest('POST', `/inventory-counts/${countId}/post`, {
    token,
    headers: { 'Idempotency-Key': idemKey },
    body: {}
  });
  assert.equal(secondPost.res.status, 200, JSON.stringify(secondPost.payload));
  assert.equal(firstPost.payload.inventoryMovementId, secondPost.payload.inventoryMovementId);

  const movementCountRes = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND idempotency_key = $2`,
    [tenantId, `cycle-count-post:${countId}:${idemKey}`]
  );
  assert.equal(Number(movementCountRes.rows[0].count), 1);

  const secondCountRes = await apiRequest('POST', '/inventory-counts', {
    token,
    body: {
      countedAt: new Date().toISOString(),
      warehouseId: warehouse.id,
      lines: [
        {
          lineNumber: 1,
          itemId,
          locationId: sellable.id,
          uom: 'each',
          countedQuantity: 3,
          reasonCode: 'shrink'
        }
      ]
    }
  });
  assert.equal(secondCountRes.res.status, 201, JSON.stringify(secondCountRes.payload));

  const conflictPost = await apiRequest('POST', `/inventory-counts/${secondCountRes.payload.id}/post`, {
    token,
    headers: { 'Idempotency-Key': idemKey },
    body: {}
  });
  assert.equal(conflictPost.res.status, 409, JSON.stringify(conflictPost.payload));
  assert.equal(conflictPost.payload?.error?.code, 'INV_COUNT_POST_IDEMPOTENCY_CONFLICT');

  const incompleteCountRes = await apiRequest('POST', '/inventory-counts', {
    token,
    body: {
      countedAt: new Date().toISOString(),
      warehouseId: warehouse.id,
      lines: [
        {
          lineNumber: 1,
          itemId,
          locationId: sellable.id,
          uom: 'each',
          countedQuantity: 2,
          reasonCode: 'shrink'
        }
      ]
    }
  });
  assert.equal(incompleteCountRes.res.status, 201, JSON.stringify(incompleteCountRes.payload));
  const incompleteCount = incompleteCountRes.payload;
  const incompletePayload = normalizeCountPostPayload(incompleteCount);
  const incompleteHash = hashPayload(incompletePayload);
  const incompleteKey = `count-post-incomplete-${randomUUID()}`;

  await db.query(
    `INSERT INTO cycle_count_post_executions (
        id, tenant_id, cycle_count_id, idempotency_key, request_hash, request_summary, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'IN_PROGRESS', now(), now())`,
    [randomUUID(), tenantId, incompleteCount.id, incompleteKey, incompleteHash, JSON.stringify(incompletePayload)]
  );

  const incompletePost = await apiRequest('POST', `/inventory-counts/${incompleteCount.id}/post`, {
    token,
    headers: { 'Idempotency-Key': incompleteKey },
    body: {}
  });
  assert.equal(incompletePost.res.status, 409, JSON.stringify(incompletePost.payload));
  assert.equal(incompletePost.payload?.error?.code, 'INV_COUNT_POST_IDEMPOTENCY_INCOMPLETE');
  assert.equal(incompletePost.payload?.error?.details?.missingMovementId, true);
});

test('cycle count posting enforces positive-adjustment cost and records FIFO shrink consumptions', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const db = session.pool;
  const tenantId = session.tenant.id;
  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:costing` });
  const sellable = defaults.SELLABLE;

  const shrinkItemId = await createItem(token, sellable.id, 'CC-SHRINK');
  await seedOnHand(token, shrinkItemId, sellable.id, 5);

  const shrinkCount = await apiRequest('POST', '/inventory-counts', {
    token,
    body: {
      countedAt: new Date().toISOString(),
      warehouseId: warehouse.id,
      lines: [
        {
          lineNumber: 1,
          itemId: shrinkItemId,
          locationId: sellable.id,
          uom: 'each',
          countedQuantity: 4,
          reasonCode: 'shrink'
        }
      ]
    }
  });
  assert.equal(shrinkCount.res.status, 201, JSON.stringify(shrinkCount.payload));

  const shrinkPost = await apiRequest('POST', `/inventory-counts/${shrinkCount.payload.id}/post`, {
    token,
    headers: { 'Idempotency-Key': `count-shrink-${randomUUID()}` },
    body: {}
  });
  assert.equal(shrinkPost.res.status, 200, JSON.stringify(shrinkPost.payload));

  const shrinkConsumptionRes = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM cost_layer_consumptions
      WHERE tenant_id = $1
        AND consumption_type = 'adjustment'
        AND consumption_document_id = $2`,
    [tenantId, shrinkCount.payload.id]
  );
  assert.ok(Number(shrinkConsumptionRes.rows[0].count) >= 1);

  const foundItemId = await createItem(token, sellable.id, 'CC-FOUND');
  const foundCountMissingCost = await apiRequest('POST', '/inventory-counts', {
    token,
    body: {
      countedAt: new Date().toISOString(),
      warehouseId: warehouse.id,
      lines: [
        {
          lineNumber: 1,
          itemId: foundItemId,
          locationId: sellable.id,
          uom: 'each',
          countedQuantity: 2,
          reasonCode: 'found'
        }
      ]
    }
  });
  assert.equal(foundCountMissingCost.res.status, 201, JSON.stringify(foundCountMissingCost.payload));

  const foundPostMissingCost = await apiRequest('POST', `/inventory-counts/${foundCountMissingCost.payload.id}/post`, {
    token,
    headers: { 'Idempotency-Key': `count-found-missing-${randomUUID()}` },
    body: {}
  });
  assert.equal(foundPostMissingCost.res.status, 409, JSON.stringify(foundPostMissingCost.payload));
  assert.equal(foundPostMissingCost.payload?.error?.code, 'CYCLE_COUNT_UNIT_COST_REQUIRED');

  const foundCount = await apiRequest('POST', '/inventory-counts', {
    token,
    body: {
      countedAt: new Date().toISOString(),
      warehouseId: warehouse.id,
      lines: [
        {
          lineNumber: 1,
          itemId: foundItemId,
          locationId: sellable.id,
          uom: 'each',
          countedQuantity: 3,
          unitCostForPositiveAdjustment: 2.5,
          reasonCode: 'found'
        }
      ]
    }
  });
  assert.equal(foundCount.res.status, 201, JSON.stringify(foundCount.payload));

  const foundPost = await apiRequest('POST', `/inventory-counts/${foundCount.payload.id}/post`, {
    token,
    headers: { 'Idempotency-Key': `count-found-${randomUUID()}` },
    body: {}
  });
  assert.equal(foundPost.res.status, 200, JSON.stringify(foundPost.payload));

  const foundLayerRes = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND source_type = 'adjustment'
        AND source_document_id = $2
        AND original_quantity > 0`,
    [tenantId, foundCount.payload.id]
  );
  assert.ok(Number(foundLayerRes.rows[0].count) >= 1);
});
