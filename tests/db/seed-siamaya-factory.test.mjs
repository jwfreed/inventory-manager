import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { getDbPool } from '../helpers/dbPool.mjs';
import { ensureTestServer, getBaseUrl } from '../api/helpers/testServer.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { runSeedPack } = require('../../scripts/seed/run.ts');
const db = getDbPool();

function getBomFixturePath() {
  return path.join(process.cwd(), 'tests/fixtures/siamaya-bom-mini.json');
}

async function fetchTenantId(slug) {
  const res = await db.query('SELECT id FROM tenants WHERE slug = $1', [slug]);
  return res.rows[0]?.id ?? null;
}

async function fetchTenantCounts(tenantId) {
  const res = await db.query(
    `SELECT
        (SELECT COUNT(*)::int FROM locations WHERE tenant_id = $1 AND type = 'warehouse') AS warehouse_count,
        (SELECT COUNT(*)::int FROM locations WHERE tenant_id = $1 AND type <> 'warehouse') AS location_count,
        (SELECT COUNT(*)::int FROM warehouse_default_location WHERE tenant_id = $1) AS default_count,
        (SELECT COUNT(*)::int FROM items WHERE tenant_id = $1) AS item_count,
        (SELECT COUNT(*)::int FROM boms WHERE tenant_id = $1) AS bom_count,
        (SELECT COUNT(*)::int FROM bom_versions WHERE tenant_id = $1) AS bom_version_count,
        (SELECT COUNT(*)::int FROM bom_version_lines WHERE tenant_id = $1) AS bom_line_count,
        (SELECT COUNT(*)::int FROM uom_conversions WHERE tenant_id = $1) AS uom_conversion_count`,
    [tenantId]
  );
  return res.rows[0];
}

async function fetchUomConversionPairCounts(tenantId) {
  const res = await db.query(
    `SELECT
        (SELECT COUNT(*)::int FROM uom_conversions WHERE tenant_id = $1 AND lower(from_uom) = 'piece' AND lower(to_uom) = 'each') AS piece_to_each,
        (SELECT COUNT(*)::int FROM uom_conversions WHERE tenant_id = $1 AND lower(from_uom) = 'each' AND lower(to_uom) = 'piece') AS each_to_piece,
        (SELECT COUNT(*)::int FROM uom_conversions WHERE tenant_id = $1 AND lower(from_uom) = 'kg' AND lower(to_uom) = 'g') AS kg_to_g,
        (SELECT COUNT(*)::int FROM uom_conversions WHERE tenant_id = $1 AND lower(from_uom) = 'g' AND lower(to_uom) = 'kg') AS g_to_kg`,
    [tenantId]
  );
  return res.rows[0];
}

async function fetchCleanReceiptMetrics(tenantId, tenantSlug) {
  const receiptPrefix = `seed:siamaya_factory:receipt:${tenantSlug}:FACTORY:%`;
  const res = await db.query(
    `WITH factory AS (
       SELECT id
         FROM locations
        WHERE tenant_id = $1
          AND code = 'FACTORY'
          AND type = 'warehouse'
        LIMIT 1
     )
     SELECT
       (SELECT COUNT(*)::int
          FROM purchase_orders po
         WHERE po.tenant_id = $1
           AND po.vendor_reference LIKE 'seed:siamaya_factory:po:FACTORY:%'
           AND po.vendor_reference NOT LIKE '%:partial') AS po_count,
       (SELECT COUNT(*)::int
          FROM purchase_order_receipts por
         WHERE por.tenant_id = $1
           AND por.idempotency_key LIKE $2
           AND por.idempotency_key NOT LIKE '%:partial') AS receipt_count,
       (SELECT COUNT(DISTINCT por.inventory_movement_id)::int
          FROM purchase_order_receipts por
         WHERE por.tenant_id = $1
           AND por.idempotency_key LIKE $2
           AND por.idempotency_key NOT LIKE '%:partial'
           AND por.inventory_movement_id IS NOT NULL) AS movement_count,
       (SELECT COUNT(*)::int
          FROM inventory_cost_layers icl
         WHERE icl.tenant_id = $1
           AND icl.source_type = 'receipt'
           AND icl.source_document_id IN (
             SELECT porl.id
               FROM purchase_order_receipt_lines porl
               JOIN purchase_order_receipts por
                 ON por.id = porl.purchase_order_receipt_id
                AND por.tenant_id = porl.tenant_id
              WHERE por.tenant_id = $1
                AND por.idempotency_key LIKE $2
                AND por.idempotency_key NOT LIKE '%:partial'
           )) AS cost_layer_count,
       (SELECT COALESCE(MAX(layer_count), 0)::int
          FROM (
            SELECT icl.item_id, COUNT(*)::int AS layer_count
              FROM inventory_cost_layers icl
              JOIN purchase_order_receipt_lines porl
                ON porl.id = icl.source_document_id
               AND porl.tenant_id = icl.tenant_id
              JOIN purchase_order_receipts por
                ON por.id = porl.purchase_order_receipt_id
               AND por.tenant_id = porl.tenant_id
              JOIN purchase_order_lines pol
                ON pol.id = porl.purchase_order_line_id
               AND pol.tenant_id = porl.tenant_id
              JOIN items i
                ON i.id = pol.item_id
               AND i.tenant_id = pol.tenant_id
              JOIN locations loc
                ON loc.id = icl.location_id
               AND loc.tenant_id = icl.tenant_id
             WHERE por.tenant_id = $1
               AND por.idempotency_key LIKE $2
               AND por.idempotency_key NOT LIKE '%:partial'
               AND lower(coalesce(i.default_uom, '')) IN ('kg', 'g')
               AND loc.warehouse_id = (SELECT id FROM factory)
             GROUP BY icl.item_id
          ) layers) AS max_raw_layer_depth,
       (SELECT COUNT(*)::int
          FROM purchase_order_receipt_lines porl
          JOIN purchase_order_receipts por
            ON por.id = porl.purchase_order_receipt_id
           AND por.tenant_id = porl.tenant_id
         WHERE por.tenant_id = $1
           AND por.idempotency_key LIKE $2
           AND por.idempotency_key NOT LIKE '%:partial'
           AND porl.discrepancy_reason IS NOT NULL) AS discrepancy_count,
       (SELECT COUNT(*)::int
          FROM purchase_order_receipts por
          JOIN inventory_movement_lines iml
            ON iml.movement_id = por.inventory_movement_id
           AND iml.tenant_id = por.tenant_id
          JOIN locations loc
            ON loc.id = iml.location_id
           AND loc.tenant_id = iml.tenant_id
         WHERE por.tenant_id = $1
           AND por.idempotency_key LIKE $2
           AND por.idempotency_key NOT LIKE '%:partial'
           AND loc.warehouse_id IS DISTINCT FROM (SELECT id FROM factory)) AS non_factory_line_count`,
    [tenantId, receiptPrefix]
  );
  return res.rows[0];
}

async function fetchRawFifoSignatures(tenantId, tenantSlug) {
  const receiptPrefix = `seed:siamaya_factory:receipt:${tenantSlug}:FACTORY:%`;
  const res = await db.query(
    `SELECT
        pol.item_id,
        ARRAY_AGG(to_char(icl.layer_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') ORDER BY icl.layer_date ASC) AS layer_dates,
        ARRAY_AGG(round(icl.unit_cost::numeric, 2)::text ORDER BY icl.layer_date ASC) AS unit_costs
       FROM inventory_cost_layers icl
       JOIN purchase_order_receipt_lines porl
         ON porl.id = icl.source_document_id
        AND porl.tenant_id = icl.tenant_id
       JOIN purchase_order_receipts por
         ON por.id = porl.purchase_order_receipt_id
        AND por.tenant_id = porl.tenant_id
       JOIN purchase_order_lines pol
         ON pol.id = porl.purchase_order_line_id
        AND pol.tenant_id = porl.tenant_id
       JOIN items i
         ON i.id = pol.item_id
        AND i.tenant_id = pol.tenant_id
      WHERE por.tenant_id = $1
        AND por.idempotency_key LIKE $2
        AND por.idempotency_key NOT LIKE '%:partial'
        AND icl.source_type = 'receipt'
        AND lower(coalesce(i.default_uom, '')) IN ('kg', 'g')
      GROUP BY pol.item_id`,
    [tenantId, receiptPrefix]
  );
  return res.rows;
}

async function fetchPartialThenCloseMetrics(tenantId, tenantSlug) {
  const receiptPrefix = `seed:siamaya_factory:receipt:${tenantSlug}:FACTORY:%:partial-close-short`;
  const poPrefix = 'seed:siamaya_factory:po:FACTORY:%:partial-close-short';
  const res = await db.query(
    `SELECT
        (SELECT COUNT(*)::int FROM purchase_orders WHERE tenant_id = $1 AND vendor_reference LIKE $3) AS po_count,
        (SELECT COUNT(*)::int FROM purchase_order_receipts WHERE tenant_id = $1 AND idempotency_key LIKE $2) AS receipt_count,
        (SELECT COUNT(*)::int
           FROM purchase_order_receipt_lines porl
           JOIN purchase_order_receipts por
             ON por.id = porl.purchase_order_receipt_id
            AND por.tenant_id = porl.tenant_id
          WHERE por.tenant_id = $1
            AND por.idempotency_key LIKE $2
            AND porl.discrepancy_reason IS NOT NULL) AS discrepancy_count,
        (SELECT COUNT(*)::int
           FROM purchase_order_lines pol
           JOIN purchase_orders po
             ON po.id = pol.purchase_order_id
            AND po.tenant_id = pol.tenant_id
          WHERE po.tenant_id = $1
            AND po.vendor_reference LIKE $3
            AND pol.status = 'closed_short') AS closed_short_count`,
    [tenantId, receiptPrefix, poPrefix]
  );
  return res.rows[0];
}

test('siamaya_factory seed pack is deterministic and idempotent', async () => {
  const suffix = randomUUID().slice(0, 8);
  const tenantSlug = `siamaya-seed-${suffix}`;
  const adminEmail = `seed-admin-${suffix}@example.test`;
  const bomFilePath = getBomFixturePath();

  const first = await runSeedPack({
    pack: 'siamaya_factory',
    tenantSlug,
    tenantName: `SIAMAYA Seed ${suffix}`,
    adminEmail,
    adminPassword: 'admin@local',
    bomFilePath
  });

  const tenantId = await fetchTenantId(tenantSlug);
  assert.ok(tenantId, 'tenant should exist after first run');

  const firstCounts = await fetchTenantCounts(tenantId);
  const firstConversionCounts = await fetchUomConversionPairCounts(tenantId);
  assert.equal(first.pack, 'siamaya_factory');
  assert.equal(first.tenant, tenantSlug);
  assert.equal(first.receiptMode, 'none');
  assert.equal(first.warehousesCreated, 4);
  assert.equal(first.locationsCreated, 17);
  assert.equal(first.usersUpserted, 1);
  assert.equal(first.itemsUpserted, 7);
  assert.equal(first.bomsUpserted, 2);
  assert.equal(first.bomVersionsUpserted, 2);
  assert.equal(first.bomLinesUpserted, 6);
  assert.ok(first.uomConversionsUpserted > 0, 'canonical uom conversions should be upserted');
  assert.deepEqual(first.unknownUoms, []);
  assert.ok(firstConversionCounts.piece_to_each > 0);
  assert.ok(firstConversionCounts.each_to_piece > 0);
  assert.ok(firstConversionCounts.kg_to_g > 0);
  assert.ok(firstConversionCounts.g_to_kg > 0);

  const second = await runSeedPack({
    pack: 'siamaya_factory',
    tenantSlug,
    tenantName: `SIAMAYA Seed ${suffix}`,
    adminEmail,
    adminPassword: 'admin@local',
    bomFilePath
  });

  const secondCounts = await fetchTenantCounts(tenantId);
  assert.deepEqual(secondCounts, firstCounts, 'second run must not increase row counts');
  assert.equal(second.warehousesCreated, 0);
  assert.equal(second.locationsCreated, 0);
  assert.equal(second.usersUpserted, 1);
  assert.equal(second.itemsUpserted, first.itemsUpserted);
  assert.equal(second.bomsUpserted, first.bomsUpserted);
  assert.equal(second.bomVersionsUpserted, first.bomVersionsUpserted);
  assert.equal(second.bomLinesUpserted, first.bomLinesUpserted);
  assert.equal(second.checksum, first.checksum, 'checksum must remain stable across runs');

  const membershipRes = await db.query(
    `SELECT tm.role, tm.status
       FROM tenant_memberships tm
       JOIN users u ON u.id = tm.user_id
      WHERE tm.tenant_id = $1
        AND lower(u.email) = lower($2)`,
    [tenantId, adminEmail]
  );
  assert.equal(membershipRes.rowCount, 1);
  assert.equal(membershipRes.rows[0].role, 'admin');
  assert.equal(membershipRes.rows[0].status, 'active');

  const duplicateItems = await db.query(
    `SELECT lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) AS normalized_name, COUNT(*)::int AS count
       FROM items
      WHERE tenant_id = $1
      GROUP BY lower(regexp_replace(trim(name), '\\s+', ' ', 'g'))
     HAVING COUNT(*) > 1`,
    [tenantId]
  );
  assert.equal(duplicateItems.rowCount, 0, 'normalized item names must remain unique per tenant');
});

test('siamaya_factory seed with receipts in clean mode is deterministic and idempotent', async () => {
  const suffix = randomUUID().slice(0, 8);
  const tenantSlug = `siamaya-seed-rx-clean-${suffix}`;
  const adminEmail = `seed-admin-rx-clean-${suffix}@example.test`;
  const bomFilePath = getBomFixturePath();

  await ensureTestServer();
  const apiBaseUrl = getBaseUrl();

  const first = await runSeedPack({
    pack: 'siamaya_factory',
    tenantSlug,
    tenantName: `SIAMAYA Seed Receipts Clean ${suffix}`,
    adminEmail,
    adminPassword: 'admin@local',
    bomFilePath,
    withReceipts: true,
    receiptMode: 'clean',
    apiBaseUrl
  });

  const tenantId = await fetchTenantId(tenantSlug);
  assert.ok(tenantId, 'tenant should exist after first clean receipt run');
  const firstMetrics = await fetchCleanReceiptMetrics(tenantId, tenantSlug);
  const firstRawSignatures = await fetchRawFifoSignatures(tenantId, tenantSlug);

  assert.equal(first.receiptMode, 'clean');
  assert.ok(first.purchaseOrdersCreated > 0, 'clean mode should create deterministic POs on first run');
  assert.equal(first.purchaseOrdersReused, 0);
  assert.ok(first.receiptsAttempted > 0, 'clean mode must attempt deterministic receipt layers');
  assert.ok(first.receiptsCreated > 0, 'first clean run should create receipts');
  assert.equal(first.receiptsReplayed, 0);
  assert.ok(first.receiptMovementsCreated > 0);
  assert.ok(first.costLayersCreatedEstimate > 0);
  assert.ok(firstMetrics.po_count > 0);
  assert.ok(firstMetrics.receipt_count > 0);
  assert.ok(firstMetrics.movement_count > 0);
  assert.ok(firstMetrics.cost_layer_count > 0);
  assert.ok(firstMetrics.max_raw_layer_depth >= 3);
  assert.equal(firstMetrics.discrepancy_count, 0, 'clean mode must not write discrepancy reasons');
  assert.equal(firstMetrics.non_factory_line_count, 0, 'clean mode receipts must remain in FACTORY warehouse scope');

  const hasExpectedRawSignature = firstRawSignatures.some((row) => {
    const dates = row.layer_dates ?? [];
    const costs = row.unit_costs ?? [];
    return (
      dates.join(',') === '2026-01-10,2026-01-20,2026-02-05'
      && costs.join(',') === '100.00,110.00,105.00'
    );
  });
  assert.ok(hasExpectedRawSignature, 'at least one raw item must have deterministic FIFO layer costs/dates');

  const second = await runSeedPack({
    pack: 'siamaya_factory',
    tenantSlug,
    tenantName: `SIAMAYA Seed Receipts Clean ${suffix}`,
    adminEmail,
    adminPassword: 'admin@local',
    bomFilePath,
    withReceipts: true,
    receiptMode: 'clean',
    apiBaseUrl
  });

  const secondMetrics = await fetchCleanReceiptMetrics(tenantId, tenantSlug);
  assert.deepEqual(secondMetrics, firstMetrics, 'second clean run must not increase persisted receipt artifacts');
  assert.equal(second.receiptMode, 'clean');
  assert.equal(second.purchaseOrdersCreated, 0);
  assert.ok(second.purchaseOrdersReused > 0);
  assert.equal(second.receiptsCreated, 0);
  assert.equal(second.receiptsAttempted, first.receiptsAttempted);
  assert.equal(second.receiptsReplayed, first.receiptsAttempted);
  assert.equal(second.receiptMovementsCreated, 0);
  assert.equal(second.costLayersCreatedEstimate, 0);
  assert.equal(second.checksum, first.checksum, 'clean mode checksum must remain stable across runs');
});

test('partial_then_close_short mode remains deterministic and closes residual PO lines explicitly', async () => {
  const suffix = randomUUID().slice(0, 8);
  const tenantSlug = `siamaya-seed-rx-partial-close-${suffix}`;
  const adminEmail = `seed-admin-rx-partial-close-${suffix}@example.test`;
  const bomFilePath = getBomFixturePath();

  await ensureTestServer();
  const apiBaseUrl = getBaseUrl();

  const first = await runSeedPack({
    pack: 'siamaya_factory',
    tenantSlug,
    tenantName: `SIAMAYA Seed Receipts Partial Close ${suffix}`,
    adminEmail,
    adminPassword: 'admin@local',
    bomFilePath,
    withReceipts: true,
    receiptMode: 'partial_then_close_short',
    apiBaseUrl
  });

  const tenantId = await fetchTenantId(tenantSlug);
  assert.ok(tenantId, 'tenant should exist after partial_then_close_short mode run');
  const firstMetrics = await fetchPartialThenCloseMetrics(tenantId, tenantSlug);
  assert.equal(first.receiptMode, 'partial_then_close_short');
  assert.ok(first.receiptsAttempted > 0);
  assert.ok(first.receiptsCreated > 0);
  assert.ok(first.lineClosuresAttempted > 0);
  assert.ok(first.lineClosuresApplied > 0);
  assert.equal(first.lineClosuresReplayed, 0);
  assert.ok(firstMetrics.po_count > 0);
  assert.ok(firstMetrics.receipt_count > 0);
  assert.equal(firstMetrics.discrepancy_count, 0, 'partial_then_close_short should not use discrepancy reasons');
  assert.ok(firstMetrics.closed_short_count > 0, 'partial_then_close_short should close residual open line quantity');

  const second = await runSeedPack({
    pack: 'siamaya_factory',
    tenantSlug,
    tenantName: `SIAMAYA Seed Receipts Partial Close ${suffix}`,
    adminEmail,
    adminPassword: 'admin@local',
    bomFilePath,
    withReceipts: true,
    receiptMode: 'partial_then_close_short',
    apiBaseUrl
  });
  const secondMetrics = await fetchPartialThenCloseMetrics(tenantId, tenantSlug);
  assert.deepEqual(secondMetrics, firstMetrics, 'second partial_then_close_short run must remain idempotent');
  assert.equal(second.receiptsCreated, 0);
  assert.equal(second.lineClosuresApplied, 0);
  assert.ok(second.lineClosuresReplayed > 0);
  assert.equal(second.checksum, first.checksum, 'partial_then_close_short checksum must remain stable');
});
