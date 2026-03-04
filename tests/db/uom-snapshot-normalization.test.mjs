import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { getInventorySnapshotSummaryDetailed } = require('../../src/services/inventorySnapshot.service.ts');
const { invalidateUomRegistryCache } = require('../../src/services/uomRegistry.service.ts');

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `uom-snapshot-${randomUUID().slice(0, 8)}`;

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

async function createItem(token, locationId, suffix) {
  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `UOM-SNAP-${suffix}`,
      name: `UOM Snapshot ${suffix}`,
      type: 'raw',
      defaultUom: 'g',
      uomDimension: 'mass',
      canonicalUom: 'g',
      stockingUom: 'g',
      defaultLocationId: locationId,
    },
  });
  assert.equal(itemRes.res.status, 201, JSON.stringify(itemRes.payload));
  return itemRes.payload.id;
}

async function seedStockLine(pool, { tenantId, itemId, locationId, quantityDelta, uom, reasonCode = 'seed' }) {
  const movementId = randomUUID();
  const lineId = randomUUID();
  const now = new Date().toISOString();

  await pool.query(
    `INSERT INTO inventory_movements (
        id, tenant_id, movement_type, status, external_ref, source_type, source_id, idempotency_key,
        occurred_at, posted_at, notes, metadata, reversal_of_movement_id, reversed_by_movement_id, reversal_reason,
        created_at, updated_at
     ) VALUES (
        $1, $2, 'adjustment', 'posted', $3, NULL, NULL, NULL,
        $4, $4, $5, NULL, NULL, NULL, NULL,
        $4, $4
     )`,
    [movementId, tenantId, `seed:${movementId}`, now, `seed ${reasonCode}`]
  );

  await pool.query(
    `INSERT INTO inventory_movement_lines (
        id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom,
        quantity_delta_entered, uom_entered, quantity_delta_canonical, canonical_uom, uom_dimension,
        unit_cost, extended_cost, reason_code, line_notes, created_at
     ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, $8, $9, $10
     )`,
    [lineId, tenantId, movementId, itemId, locationId, quantityDelta, uom, reasonCode, `seed:${reasonCode}`, now]
  );
}

async function withSnapshotNormalizationEnabled(fn) {
  const previous = process.env.ENABLE_SNAPSHOT_UOM_NORMALIZATION;
  process.env.ENABLE_SNAPSHOT_UOM_NORMALIZATION = 'true';
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.ENABLE_SNAPSHOT_UOM_NORMALIZATION;
    } else {
      process.env.ENABLE_SNAPSHOT_UOM_NORMALIZATION = previous;
    }
  }
}

test('snapshot summary aggregates mixed convertible UOM rows when stock UOM is configured', async () => {
  await withSnapshotNormalizationEnabled(async () => {
    const session = await ensureDbSession({
      apiRequest,
      adminEmail,
      adminPassword,
      tenantSlug,
      tenantName: 'UOM Snapshot Aggregation Tenant',
    });
    const token = session.accessToken;
    const tenantId = session.tenant?.id;
    assert.ok(tenantId, 'tenant required');

    const { warehouse, defaults } = await ensureStandardWarehouse({
      token,
      apiRequest,
      scope: `${import.meta.url}:aggregate`,
    });

    const itemId = await createItem(token, defaults.SELLABLE.id, Date.now());

    await seedStockLine(session.pool, {
      tenantId,
      itemId,
      locationId: defaults.SELLABLE.id,
      quantityDelta: 1,
      uom: 'kg',
    });
    await seedStockLine(session.pool, {
      tenantId,
      itemId,
      locationId: defaults.SELLABLE.id,
      quantityDelta: 500,
      uom: 'g',
    });

    const summary = await getInventorySnapshotSummaryDetailed(tenantId, {
      warehouseId: warehouse.id,
      itemId,
      locationId: defaults.SELLABLE.id,
      limit: 100,
      offset: 0,
    });

    const rows = summary.data.filter(
      (row) => row.itemId === itemId && row.locationId === defaults.SELLABLE.id
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].uom.toLowerCase(), 'g');
    assert.equal(rows[0].onHand, 1500);
    assert.equal(rows[0].available, 1500);
    assert.equal(
      summary.diagnostics.uomInconsistencies.some(
        (entry) => entry.itemId === itemId && entry.locationId === defaults.SELLABLE.id
      ),
      false
    );
    assert.deepEqual(summary.diagnostics.uomNormalizationDiagnostics, []);
    assert.deepEqual(summary.diagnostics.uomInconsistencies, []);
  });
});

test('snapshot normalization keeps analytics precision before final output rounding', async () => {
  await withSnapshotNormalizationEnabled(async () => {
    const session = await ensureDbSession({
      apiRequest,
      adminEmail,
      adminPassword,
      tenantSlug: `${tenantSlug}-analytics-precision`,
      tenantName: 'UOM Snapshot Analytics Precision Tenant',
    });
    const token = session.accessToken;
    const tenantId = session.tenant?.id;
    assert.ok(tenantId, 'tenant required');

    const { warehouse, defaults } = await ensureStandardWarehouse({
      token,
      apiRequest,
      scope: `${import.meta.url}:analytics-precision`,
    });

    const itemId = await createItem(token, defaults.SELLABLE.id, `${Date.now()}-precision`);
    const microUomA = `micro_${randomUUID().slice(0, 8)}`;
    const microUomB = `micro_${randomUUID().slice(0, 8)}`;

    await session.pool.query(
      `INSERT INTO uoms (code, name, dimension, base_code, to_base_factor, precision, active, created_at, updated_at)
       VALUES
        ($1, $2, 'mass', 'g', 0.000001, 6, true, now(), now()),
        ($3, $4, 'mass', 'g', 0.000001, 6, true, now(), now())`,
      [microUomA, `Micro A ${microUomA}`, microUomB, `Micro B ${microUomB}`]
    );
    invalidateUomRegistryCache();
    try {
      await seedStockLine(session.pool, {
        tenantId,
        itemId,
        locationId: defaults.SELLABLE.id,
        quantityDelta: 0.4,
        uom: microUomA,
      });
      await seedStockLine(session.pool, {
        tenantId,
        itemId,
        locationId: defaults.SELLABLE.id,
        quantityDelta: 0.4,
        uom: microUomB,
      });

      const summary = await getInventorySnapshotSummaryDetailed(tenantId, {
        warehouseId: warehouse.id,
        itemId,
        locationId: defaults.SELLABLE.id,
        limit: 100,
        offset: 0,
      });

      const rows = summary.data.filter(
        (row) => row.itemId === itemId && row.locationId === defaults.SELLABLE.id
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].uom.toLowerCase(), 'g');
      assert.equal(rows[0].onHand, 0.000001);
      assert.equal(rows[0].available, 0.000001);
    } finally {
      await session.pool.query(`DELETE FROM uoms WHERE code = ANY($1::text[])`, [[microUomA, microUomB]]);
      invalidateUomRegistryCache();
    }
  });
});

test('snapshot summary keeps watch diagnostics when legacy fallback conversion is used', async () => {
  await withSnapshotNormalizationEnabled(async () => {
    const session = await ensureDbSession({
      apiRequest,
      adminEmail,
      adminPassword,
      tenantSlug: `${tenantSlug}-legacy-watch`,
      tenantName: 'UOM Snapshot Legacy Fallback Watch Tenant',
    });
    const token = session.accessToken;
    const tenantId = session.tenant?.id;
    assert.ok(tenantId, 'tenant required');

    const { warehouse, defaults } = await ensureStandardWarehouse({
      token,
      apiRequest,
      scope: `${import.meta.url}:legacy-watch`,
    });

    const itemId = await createItem(token, defaults.SELLABLE.id, `${Date.now()}-legacy`);
    const legacyFrom = `legacy_${randomUUID().slice(0, 8)}`;

    await session.pool.query(
      `INSERT INTO uom_conversions (
          id, tenant_id, item_id, from_uom, to_uom, factor, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'g', 1000, now(), now())`,
      [randomUUID(), tenantId, itemId, legacyFrom]
    );

    await seedStockLine(session.pool, {
      tenantId,
      itemId,
      locationId: defaults.SELLABLE.id,
      quantityDelta: 1,
      uom: legacyFrom,
    });
    await seedStockLine(session.pool, {
      tenantId,
      itemId,
      locationId: defaults.SELLABLE.id,
      quantityDelta: 250,
      uom: 'g',
    });

    const summary = await getInventorySnapshotSummaryDetailed(tenantId, {
      warehouseId: warehouse.id,
      itemId,
      locationId: defaults.SELLABLE.id,
      limit: 100,
      offset: 0,
    });

    const rows = summary.data.filter(
      (row) => row.itemId === itemId && row.locationId === defaults.SELLABLE.id
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].uom.toLowerCase(), 'g');
    assert.equal(rows[0].onHand, 1250);

    const diag = summary.diagnostics.uomNormalizationDiagnostics.find(
      (entry) => entry.itemId === itemId && entry.locationId === defaults.SELLABLE.id
    );
    assert.ok(diag);
    assert.equal(diag.status, 'LEGACY_FALLBACK_USED');
    assert.equal(diag.severity, 'watch');
    assert.equal(diag.canAggregate, true);
    assert.ok(diag.traces.some((trace) => trace.status === 'LEGACY_FALLBACK_USED'));

    const legacyAliasDiag = summary.diagnostics.uomInconsistencies.find(
      (entry) => entry.itemId === itemId && entry.locationId === defaults.SELLABLE.id
    );
    assert.ok(legacyAliasDiag);
  });
});

test('snapshot summary fails conservative when any row is non-convertible', async () => {
  await withSnapshotNormalizationEnabled(async () => {
    const session = await ensureDbSession({
      apiRequest,
      adminEmail,
      adminPassword,
      tenantSlug: `${tenantSlug}-nonconvertible`,
      tenantName: 'UOM Snapshot Non Convertible Tenant',
    });
    const token = session.accessToken;
    const tenantId = session.tenant?.id;
    assert.ok(tenantId, 'tenant required');

    const { warehouse, defaults } = await ensureStandardWarehouse({
      token,
      apiRequest,
      scope: `${import.meta.url}:non-convertible`,
    });

    const itemId = await createItem(token, defaults.SELLABLE.id, `${Date.now()}-mixed`);

    await seedStockLine(session.pool, {
      tenantId,
      itemId,
      locationId: defaults.SELLABLE.id,
      quantityDelta: 100,
      uom: 'g',
    });
    await seedStockLine(session.pool, {
      tenantId,
      itemId,
      locationId: defaults.SELLABLE.id,
      quantityDelta: 2,
      uom: 'ea',
    });

    const summary = await getInventorySnapshotSummaryDetailed(tenantId, {
      warehouseId: warehouse.id,
      itemId,
      locationId: defaults.SELLABLE.id,
      limit: 100,
      offset: 0,
    });

    const rows = summary.data.filter(
      (row) => row.itemId === itemId && row.locationId === defaults.SELLABLE.id
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.uom.toLowerCase()).sort((left, right) => left.localeCompare(right)),
      ['ea', 'g']
    );

    const inconsistency = summary.diagnostics.uomNormalizationDiagnostics.find(
      (entry) => entry.itemId === itemId && entry.locationId === defaults.SELLABLE.id
    );
    assert.ok(inconsistency);
    assert.equal(inconsistency.reason, 'NON_CONVERTIBLE_UOM');
    assert.equal(inconsistency.severity, 'action');
    assert.equal(inconsistency.canAggregate, false);
    assert.equal(inconsistency.status, 'DIMENSION_MISMATCH');

    const deprecatedAlias = summary.diagnostics.uomInconsistencies.find(
      (entry) => entry.itemId === itemId && entry.locationId === defaults.SELLABLE.id
    );
    assert.ok(deprecatedAlias);
  });
});
