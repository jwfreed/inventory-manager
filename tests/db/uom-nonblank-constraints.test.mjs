import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import { insertPostedMovementFixture } from '../helpers/movementFixture.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `uom-constraints-${randomUUID().slice(0, 8)}`;
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

async function getSession() {
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'UOM Constraint Tenant',
  });
  db = session.pool;
  return session;
}

async function createItem(token, defaultLocationId, prefix = 'UOM') {
  const sku = `${prefix}-${randomUUID().slice(0, 8)}`;
  const itemRes = await apiRequest('POST', '/items', {
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
    },
  });
  assert.equal(itemRes.res.status, 201, JSON.stringify(itemRes.payload));
  return itemRes.payload.id;
}

test('inventory_balance and inventory_movement_lines reject blank and whitespace uom', async () => {
  const session = await getSession();
  const tenantId = session.tenant?.id;
  const token = session.accessToken;
  assert.ok(tenantId, 'tenantId required');
  assert.ok(token, 'token required');

  const { defaults } = await ensureStandardWarehouse({
    token,
    apiRequest,
    scope: `${import.meta.url}:uom-constraints`,
  });
  const itemId = await createItem(token, defaults.SELLABLE.id, 'UOMC');

  await assert.rejects(
    db.query(
      `INSERT INTO inventory_balance (
          tenant_id, item_id, location_id, uom, on_hand, reserved, allocated, created_at, updated_at
       ) VALUES ($1, $2, $3, '', 1, 0, 0, now(), now())`,
      [tenantId, itemId, defaults.SELLABLE.id],
    ),
    (error) =>
      error?.code === '23514'
      && String(error?.constraint ?? '') === 'inventory_balance_uom_not_blank',
  );

  await assert.rejects(
    db.query(
      `INSERT INTO inventory_balance (
          tenant_id, item_id, location_id, uom, on_hand, reserved, allocated, created_at, updated_at
       ) VALUES ($1, $2, $3, '   ', 1, 0, 0, now(), now())`,
      [tenantId, itemId, defaults.SELLABLE.id],
    ),
    (error) =>
      error?.code === '23514'
      && String(error?.constraint ?? '') === 'inventory_balance_uom_not_blank',
  );

  const { movementId } = await insertPostedMovementFixture(db, {
    tenantId,
    movementType: 'adjustment',
    sourceType: 'uom_constraint_fixture',
    sourceId: randomUUID(),
    notes: 'uom constraint fixture',
    lines: [
      {
        itemId,
        locationId: defaults.SELLABLE.id,
        quantityDelta: 1,
        uom: 'each',
        quantityDeltaEntered: 1,
        uomEntered: 'each',
        quantityDeltaCanonical: 1,
        canonicalUom: 'each',
        uomDimension: 'count',
        reasonCode: 'uom_constraint_fixture',
        lineNotes: 'valid fixture line'
      }
    ],
  });

  await assert.rejects(
    db.query(
      `INSERT INTO inventory_movement_lines (
          id, tenant_id, movement_id, source_line_id, item_id, location_id, quantity_delta, uom, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, '', now())`,
      [randomUUID(), tenantId, movementId, 'uom-empty-fixture', itemId, defaults.SELLABLE.id],
    ),
    (error) =>
      error?.code === '23514'
      && String(error?.constraint ?? '') === 'inventory_movement_lines_uom_not_blank',
  );

  await assert.rejects(
    db.query(
      `INSERT INTO inventory_movement_lines (
          id, tenant_id, movement_id, source_line_id, item_id, location_id, quantity_delta, uom, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, '   ', now())`,
      [randomUUID(), tenantId, movementId, 'uom-whitespace-fixture', itemId, defaults.SELLABLE.id],
    ),
    (error) =>
      error?.code === '23514'
      && String(error?.constraint ?? '') === 'inventory_movement_lines_uom_not_blank',
  );
});

test('uom non-blank constraints are present and validated', async () => {
  await getSession();

  const result = await db.query(
    `SELECT conname, convalidated
       FROM pg_constraint
      WHERE conname = ANY($1::text[])
      ORDER BY conname`,
    [[
      'inventory_balance_uom_not_blank',
      'inventory_movement_lines_uom_not_blank',
    ]],
  );

  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.rows.map((row) => row.conname), [
    'inventory_balance_uom_not_blank',
    'inventory_movement_lines_uom_not_blank',
  ]);
  assert.ok(result.rows.every((row) => row.convalidated === true));
});
