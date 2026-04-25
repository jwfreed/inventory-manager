import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { getTestTenantWithValidTopology } from '../helpers/topologyTenant.mjs';
import { insertPostedMovementFixture } from '../helpers/movementFixture.mjs';

const execFileAsync = promisify(execFile);
const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSectionCount(stdout, sectionName) {
  const match = new RegExp(`\\[${escapeRegex(sectionName)}\\] count=(\\d+)`).exec(stdout);
  assert.ok(match, `Missing invariant section: ${sectionName}`);
  return Number(match[1]);
}

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

async function createItem(token, defaultLocationId, prefix) {
  const sku = `${prefix}-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      type: 'raw',
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

async function getSellableDefault(pool, tenantId) {
  const res = await pool.query(
    `SELECT wdl.warehouse_id,
            wdl.location_id,
            l.code AS location_code
       FROM warehouse_default_location wdl
       JOIN locations l
         ON l.id = wdl.location_id
        AND l.tenant_id = wdl.tenant_id
      WHERE wdl.tenant_id = $1
        AND wdl.role = 'SELLABLE'
      ORDER BY l.code
      LIMIT 1`,
    [tenantId]
  );
  assert.equal(res.rowCount, 1, `SELLABLE default missing for tenant ${tenantId}`);
  return {
    warehouseId: res.rows[0].warehouse_id,
    locationId: res.rows[0].location_id
  };
}

async function runInvariantScript({ tenantId, strict = false, limit = 25 }) {
  const args = ['scripts/inventory_invariants_check.mjs', '--tenant-id', tenantId, '--limit', String(limit)];
  if (strict) args.push('--strict');
  return execFileAsync(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      INVARIANTS_STRICT: strict ? 'true' : 'false'
    },
    maxBuffer: 4 * 1024 * 1024
  });
}

async function runInvariantStrictExpectFailure(tenantId) {
  let stdout = '';
  let stderr = '';
  await assert.rejects(
    async () => {
      await runInvariantScript({ tenantId, strict: true, limit: 25 });
    },
    (error) => {
      stdout = String(error?.stdout ?? '');
      stderr = String(error?.stderr ?? '');
      return error?.code === 2;
    }
  );
  return { stdout, stderr };
}

async function insertNegativeOnHandFixture({ pool, tenantId, itemId, locationId }) {
  await insertPostedMovementFixture(pool, {
    tenantId,
    movementType: 'adjustment',
    sourceType: 'test_fixture',
    sourceId: randomUUID(),
    externalRef: `NEG-ON-HAND-${randomUUID()}`,
    notes: 'negative on_hand fixture',
    project: false,
    lines: [
      {
        itemId,
        locationId,
        quantityDelta: -5,
        uom: 'each',
        quantityDeltaEntered: -5,
        uomEntered: 'each',
        quantityDeltaCanonical: -5,
        canonicalUom: 'each',
        uomDimension: 'count',
        unitCost: 0,
        extendedCost: 0,
        reasonCode: 'phase42_negative_on_hand',
        lineNotes: 'negative on_hand fixture line'
      }
    ]
  });
}

async function insertCostLayerFixtures({
  pool,
  tenantId,
  validItemId,
  validLocationId,
  foreignItemId,
  foreignLocationId
}) {
  const now = new Date();
  await pool.query(
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
        source_document_id,
        movement_id,
        lot_id,
        notes,
        created_at,
        updated_at
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        'each',
        $5,
        1,
        4,
        4,
        3,
        12,
        'adjustment',
        $6,
        NULL,
        NULL,
        'unmatched layer fixture',
        $5,
        $5
      )`,
    [randomUUID(), tenantId, validItemId, validLocationId, now, randomUUID()]
  );

  // TEST-ONLY fixture: intentionally cross-tenant references to validate orphan detection paths.
  await pool.query(
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
        source_document_id,
        movement_id,
        lot_id,
        notes,
        created_at,
        updated_at
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        'each',
        $5,
        2,
        2,
        2,
        7,
        14,
        'adjustment',
        $6,
        NULL,
        NULL,
        'orphan layer fixture',
        $5,
        $5
      )`,
    [randomUUID(), tenantId, foreignItemId, foreignLocationId, now, randomUUID()]
  );
}

test('strict expanded invariants pass on a clean tenant with canonical topology', { timeout: 120000 }, async () => {
  const session = await getTestTenantWithValidTopology({
    tenantName: 'Strict Expanded Invariants Clean Tenant'
  });
  const tenantId = session.tenant?.id;
  assert.ok(tenantId, 'tenantId is required');

  const { stdout, stderr } = await runInvariantScript({ tenantId, strict: true, limit: 25 });
  assert.equal(stderr.trim(), '', stderr);
  assert.equal(getSectionCount(stdout, 'warehouse_default_completeness_invalid'), 0);
  assert.equal(getSectionCount(stdout, 'negative_on_hand'), 0);
  assert.equal(getSectionCount(stdout, 'unmatched_cost_layers'), 0);
  assert.equal(getSectionCount(stdout, 'orphaned_cost_layers'), 0);
  assert.equal(getSectionCount(stdout, 'production_receipt_location_validity'), 0);
  assert.equal(getSectionCount(stdout, 'wo_component_quantity_exact_match'), 0);
  assert.equal(getSectionCount(stdout, 'production_fifo_layer_continuity'), 0);
  assert.equal(getSectionCount(stdout, 'po_line_closed_blocks_receipts'), 0);
  assert.equal(getSectionCount(stdout, 'po_status_consistency'), 0);
  assert.equal(getSectionCount(stdout, 'po_received_qty_integrity_invalid'), 0);
});

test('negative_on_hand check detects rollback-scoped negative ledger position', { timeout: 120000 }, async () => {
  const session = await getTestTenantWithValidTopology({
    tenantName: 'Strict Expanded Invariants Negative On Hand Tenant'
  });
  const tenantId = session.tenant?.id;
  const token = session.accessToken;
  assert.ok(tenantId, 'tenantId is required');
  assert.ok(token, 'token is required');

  const sellable = await getSellableDefault(session.pool, tenantId);
  const itemId = await createItem(token, sellable.locationId, 'NEG-OH');
  const client = await session.pool.connect();
  try {
    await client.query('BEGIN');
    await insertNegativeOnHandFixture({
      pool: client,
      tenantId,
      itemId,
      locationId: sellable.locationId
    });

    const negativeRows = await client.query(
      `SELECT tenant_id,
              warehouse_id,
              location_id,
              item_id,
              uom,
              on_hand_qty
         FROM inventory_on_hand_location_v
        WHERE tenant_id = $1
          AND warehouse_id = $2
          AND item_id = $3
          AND location_id = $4
          AND on_hand_qty < -0.000001`,
      [tenantId, sellable.warehouseId, itemId, sellable.locationId]
    );
    assert.equal(negativeRows.rowCount, 1);
    assert.equal(negativeRows.rows[0]?.tenant_id, tenantId);
    assert.equal(negativeRows.rows[0]?.warehouse_id, sellable.warehouseId);
    assert.equal(negativeRows.rows[0]?.item_id, itemId);
    assert.equal(Number(negativeRows.rows[0]?.on_hand_qty), -5);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});

test('unmatched_cost_layers and orphaned_cost_layers detect controlled fixture drift', { timeout: 120000 }, async () => {
  const primary = await getTestTenantWithValidTopology({
    tenantName: 'Strict Expanded Invariants Layer Drift Primary Tenant'
  });
  const primaryTenantId = primary.tenant?.id;
  const primaryToken = primary.accessToken;
  assert.ok(primaryTenantId, 'primary tenantId is required');
  assert.ok(primaryToken, 'primary token is required');

  const primarySellable = await getSellableDefault(primary.pool, primaryTenantId);
  const primaryItemId = await createItem(primaryToken, primarySellable.locationId, 'UNMATCHED');

  const foreign = await getTestTenantWithValidTopology({
    tenantName: 'Strict Expanded Invariants Layer Drift Foreign Tenant'
  });
  const foreignTenantId = foreign.tenant?.id;
  const foreignToken = foreign.accessToken;
  assert.ok(foreignTenantId, 'foreign tenantId is required');
  assert.ok(foreignToken, 'foreign token is required');

  const foreignSellable = await getSellableDefault(foreign.pool, foreignTenantId);
  const foreignItemId = await createItem(foreignToken, foreignSellable.locationId, 'ORPHAN');

  await insertCostLayerFixtures({
    pool: primary.pool,
    tenantId: primaryTenantId,
    validItemId: primaryItemId,
    validLocationId: primarySellable.locationId,
    foreignItemId,
    foreignLocationId: foreignSellable.locationId
  });

  const nonStrictRun = await runInvariantScript({ tenantId: primaryTenantId, strict: false, limit: 25 });
  const unmatchedCount = getSectionCount(nonStrictRun.stdout, 'unmatched_cost_layers');
  const orphanedCount = getSectionCount(nonStrictRun.stdout, 'orphaned_cost_layers');
  assert.ok(unmatchedCount > 0, nonStrictRun.stdout);
  assert.ok(orphanedCount > 0, nonStrictRun.stdout);
  assert.match(nonStrictRun.stdout, /"issue_code":"ITEM_TENANT_MISMATCH_OR_MISSING"/);

  const strictFailure = await runInvariantStrictExpectFailure(primaryTenantId);
  const strictCombined = `${strictFailure.stdout}\n${strictFailure.stderr}`;
  assert.match(strictFailure.stdout, /\[unmatched_cost_layers\] count=/);
  assert.match(strictFailure.stdout, /\[orphaned_cost_layers\] count=/);
  assert.match(strictCombined, /"unmatched_cost_layers":/);
  assert.match(strictCombined, /"orphaned_cost_layers":/);
});
