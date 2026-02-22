import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import { expectInvariantLog } from '../helpers/invariantLogs.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { runInventoryInvariantCheck } = require('../../src/jobs/inventoryInvariants.job.ts');

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `invariants-${randomUUID().slice(0, 8)}`;
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
    tenantSlug: tenantSlug,
    tenantName: 'Invariant Tenant'
  });
  db = session.pool;
  return session;
}

async function createItem(token, defaultLocationId, prefix = 'INV') {
  const sku = `${prefix}-${randomUUID().slice(0, 8)}`;
  const itemRes = await apiRequest('POST', '/items', {
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
  assert.equal(itemRes.res.status, 201, JSON.stringify(itemRes.payload));
  return itemRes.payload.id;
}

test('invariants job reports zero legacy source_type gaps for a clean tenant', async () => {
  const session = await getSession();
  const tenantId = session.tenant?.id;
  assert.ok(tenantId);

  const results = await runInventoryInvariantCheck({ tenantIds: [tenantId] });
  const summary = results.find((row) => row.tenantId === tenantId);
  assert.ok(summary);
  assert.equal(summary.receiptLegacyMovementCount, 0);
  assert.equal(summary.qcLegacyMovementCount, 0);

  const receiveLegacy = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND movement_type = 'receive'
        AND source_type IS NULL`,
    [tenantId]
  );
  assert.equal(Number(receiveLegacy.rows[0]?.count ?? 0), 0);
});

test('receive/transfer movements require source_type and source_id', async () => {
  const session = await getSession();
  const tenantId = session.tenant?.id;
  assert.ok(tenantId);

  await assert.rejects(
    db.query(
      `INSERT INTO inventory_movements (
          id, tenant_id, movement_type, status, occurred_at, created_at, updated_at
       ) VALUES ($1, $2, 'receive', 'posted', now(), now(), now())`,
      [randomUUID(), tenantId]
    ),
    (error) =>
      error?.code === '23514'
      && String(error?.constraint ?? '').includes('chk_inventory_movements_receive_transfer_source_required')
  );

  await assert.rejects(
    db.query(
      `INSERT INTO inventory_movements (
          id, tenant_id, movement_type, status, source_type, occurred_at, created_at, updated_at
       ) VALUES ($1, $2, 'transfer', 'posted', 'putaway', now(), now(), now())`,
      [randomUUID(), tenantId]
    ),
    (error) =>
      error?.code === '23514'
      && String(error?.constraint ?? '').includes('chk_inventory_movements_receive_transfer_source_required')
  );
});

test('receive/transfer source metadata constraint is validated in schema', async () => {
  const session = await getSession();
  assert.ok(session?.tenant?.id);

  const result = await db.query(
    `SELECT convalidated
       FROM pg_constraint
      WHERE conname = 'chk_inventory_movements_receive_transfer_source_required'`
  );
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0]?.convalidated, true);
});

test('invariants detect ATP oversell condition on sellable warehouse scope', async () => {
  const session = await getSession();
  const tenantId = session.tenant?.id;
  const token = session.accessToken;
  assert.ok(tenantId, 'tenantId required');
  assert.ok(token, 'token required');

  const { warehouse, defaults } = await ensureStandardWarehouse({
    token,
    apiRequest,
    scope: `${import.meta.url}:atp-oversell`
  });
  const itemId = await createItem(token, defaults.SELLABLE.id, 'OVR');
  const reservationId = randomUUID();

  await db.query(
    `INSERT INTO inventory_reservations (
        id,
        tenant_id,
        client_id,
        status,
        demand_type,
        demand_id,
        item_id,
        location_id,
        warehouse_id,
        uom,
        quantity_reserved,
        quantity_fulfilled,
        reserved_at,
        created_at,
        updated_at
      ) VALUES (
        $1,
        $2,
        $2,
        'RESERVED',
        'sales_order_line',
        $3,
        $4,
        $5,
        $6,
        'each',
        3,
        0,
        now(),
        now(),
        now()
      )`,
    [reservationId, tenantId, randomUUID(), itemId, defaults.SELLABLE.id, warehouse.id]
  );

  await db.query(
    `INSERT INTO inventory_balance (
        tenant_id, item_id, location_id, uom, on_hand, reserved, allocated, created_at, updated_at
      ) VALUES ($1, $2, $3, 'each', 2, 3, 0, now(), now())
      ON CONFLICT (tenant_id, item_id, location_id, uom)
      DO UPDATE SET on_hand = EXCLUDED.on_hand,
                    reserved = EXCLUDED.reserved,
                    allocated = EXCLUDED.allocated,
                    updated_at = now()`,
    [tenantId, itemId, defaults.SELLABLE.id]
  );

  expectInvariantLog(/ATP oversell condition/);
  const results = await runInventoryInvariantCheck({ tenantIds: [tenantId] });
  const summary = results.find((row) => row.tenantId === tenantId);
  assert.ok(summary, 'summary expected');
  assert.ok((summary.atpOversellDetectedCount ?? 0) > 0, JSON.stringify(summary));
});
