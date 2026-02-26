import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import { stopTestServer } from '../api/helpers/testServer.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `ledger-immutability-${randomUUID().slice(0, 8)}`;
const openPools = new Set();

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

async function getSession() {
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Ledger Immutability Guard Tenant'
  });
  if (session.pool) openPools.add(session.pool);
  return session;
}

async function createItem(token, defaultLocationId) {
  const sku = `LGR-${randomUUID().slice(0, 8)}`;
  const result = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Ledger ${sku}`,
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId
    }
  });
  assert.equal(result.res.status, 201, JSON.stringify(result.payload));
  return result.payload.id;
}

async function insertLedgerFixture({ db, tenantId, itemId, locationId }) {
  const movementId = randomUUID();
  const movementLineId = randomUUID();

  await db.query(
    `INSERT INTO inventory_movements (
        id,
        tenant_id,
        movement_type,
        status,
        external_ref,
        source_type,
        source_id,
        idempotency_key,
        occurred_at,
        posted_at,
        notes,
        metadata,
        reversal_of_movement_id,
        reversed_by_movement_id,
        reversal_reason,
        created_at,
        updated_at
      ) VALUES (
        $1,
        $2,
        'adjustment',
        'posted',
        $3,
        'test_fixture',
        $4,
        NULL,
        now(),
        now(),
        'ledger immutability fixture',
        NULL,
        NULL,
        NULL,
        NULL,
        now(),
        now()
      )`,
    [movementId, tenantId, `LEDGER-FIXTURE-${movementId}`, randomUUID()]
  );

  await db.query(
    `INSERT INTO inventory_movement_lines (
        id,
        tenant_id,
        movement_id,
        item_id,
        location_id,
        quantity_delta,
        uom,
        quantity_delta_entered,
        uom_entered,
        quantity_delta_canonical,
        canonical_uom,
        uom_dimension,
        unit_cost,
        extended_cost,
        reason_code,
        line_notes,
        created_at
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        1,
        'each',
        1,
        'each',
        1,
        'each',
        'count',
        0,
        0,
        'ledger_immutability_fixture',
        'fixture line',
        now()
      )`,
    [movementLineId, tenantId, movementId, itemId, locationId]
  );

  return { movementId, movementLineId };
}

function assertAppendOnlyError(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return message.includes('append-only') || message.includes('ledger tables are append-only');
}

test.after(async () => {
  await Promise.all(
    Array.from(openPools).map(async (pool) => {
      try {
        await pool.end();
      } catch {
        // Ignore teardown failures.
      }
    })
  );
  openPools.clear();
  await stopTestServer();
});

test('ledger tables reject UPDATE/DELETE and remain insertable', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const db = session.pool;
  assert.ok(token);
  assert.ok(tenantId);

  const { defaults } = await ensureStandardWarehouse({
    token,
    apiRequest,
    scope: `${import.meta.url}:ledger-immutability`
  });

  const itemId = await createItem(token, defaults.SELLABLE.id);
  const fixture = await insertLedgerFixture({
    db,
    tenantId,
    itemId,
    locationId: defaults.SELLABLE.id
  });

  const inserted = await db.query(
    `SELECT id
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, fixture.movementLineId]
  );
  assert.equal(inserted.rowCount, 1, 'fixture insert should succeed');

  await assert.rejects(
    db.query(
      `UPDATE inventory_movement_lines
          SET quantity_delta = quantity_delta
        WHERE tenant_id = $1
          AND id = $2`,
      [tenantId, fixture.movementLineId]
    ),
    assertAppendOnlyError
  );

  await assert.rejects(
    db.query(
      `DELETE FROM inventory_movement_lines
        WHERE tenant_id = $1
          AND id = $2`,
      [tenantId, fixture.movementLineId]
    ),
    assertAppendOnlyError
  );

  await assert.rejects(
    db.query(
      `UPDATE inventory_movements
          SET notes = notes
        WHERE tenant_id = $1
          AND id = $2`,
      [tenantId, fixture.movementId]
    ),
    assertAppendOnlyError
  );

  await assert.rejects(
    db.query(
      `DELETE FROM inventory_movements
        WHERE tenant_id = $1
          AND id = $2`,
      [tenantId, fixture.movementId]
    ),
    assertAppendOnlyError
  );
});
