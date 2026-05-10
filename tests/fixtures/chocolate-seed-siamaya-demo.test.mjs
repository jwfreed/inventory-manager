import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ensureTestServer, getBaseUrl } from '../api/helpers/testServer.mjs';
import { getDbPool } from '../helpers/dbPool.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-siamaya-seed';

const {
  runChocolateSeed,
  DEMO_BOM_CODE,
  DEMO_BOM_COMPONENTS,
  DEMO_CUSTOMER,
  DEMO_FINISHED_GOOD,
  DEMO_FLOW_IDS,
  DEMO_FLOW_QUANTITY,
  DEMO_PO,
  DEMO_SKUS,
  DEMO_SO,
  DEMO_SUPPLIER
} = require('../../scripts/chocolate-seed.ts');

const TEST_TENANT_SLUG = 'siamaya';

function seedConfig(mode, tenantSlug) {
  return {
    mode,
    baseUrl: getBaseUrl(),
    prefix: '',
    adminEmail: `siamaya-seed-${tenantSlug}@example.test`,
    adminPassword: 'admin@local',
    tenantSlug,
    tenantName: 'SIAMAYA',
    logLevel: 'error',
    timeoutMs: 60000,
    reset: true,
    allowLocalAuthRepair: true
  };
}

async function tenantIdForSlug(pool, slug) {
  const result = await pool.query('SELECT id FROM tenants WHERE slug = $1', [slug]);
  const tenantId = result.rows[0]?.id;
  assert.ok(tenantId, `tenant missing for ${slug}`);
  return tenantId;
}

async function readManualSeedState(pool, tenantId) {
  const [items, bom, po, so, shipped] = await Promise.all([
    pool.query(
      `SELECT sku, type, default_uom, canonical_uom, stocking_uom, is_purchasable, is_manufactured
         FROM items
        WHERE tenant_id = $1
        ORDER BY sku`,
      [tenantId]
    ),
    pool.query(
      `SELECT b.bom_code,
              bv.status,
              bv.yield_quantity::numeric AS yield_quantity,
              bv.yield_uom,
              i.sku,
              bvl.component_quantity::numeric AS component_quantity,
              bvl.component_uom
         FROM boms b
         JOIN bom_versions bv
           ON bv.bom_id = b.id
          AND bv.tenant_id = b.tenant_id
         JOIN bom_version_lines bvl
           ON bvl.bom_version_id = bv.id
          AND bvl.tenant_id = bv.tenant_id
         JOIN items i
           ON i.id = bvl.component_item_id
          AND i.tenant_id = bvl.tenant_id
        WHERE b.tenant_id = $1
          AND b.bom_code = $2
          AND bv.status = 'active'
        ORDER BY bvl.line_number`,
      [tenantId, DEMO_BOM_CODE]
    ),
    pool.query(
      `SELECT i.sku, pol.quantity_ordered::numeric AS quantity_ordered, pol.uom
         FROM purchase_orders po
         JOIN vendors v
           ON v.id = po.vendor_id
          AND v.tenant_id = po.tenant_id
         JOIN purchase_order_lines pol
           ON pol.purchase_order_id = po.id
          AND pol.tenant_id = po.tenant_id
         JOIN items i
           ON i.id = pol.item_id
          AND i.tenant_id = pol.tenant_id
        WHERE po.tenant_id = $1
          AND po.po_number = $2
          AND v.code = $3
        ORDER BY pol.line_number`,
      [tenantId, DEMO_PO.number, DEMO_SUPPLIER.code]
    ),
    pool.query(
      `SELECT c.code,
              i.sku,
              sol.quantity_ordered::numeric AS quantity_ordered,
              sol.uom
         FROM sales_orders so
         JOIN customers c
           ON c.id = so.customer_id
          AND c.tenant_id = so.tenant_id
         JOIN sales_order_lines sol
           ON sol.sales_order_id = so.id
          AND sol.tenant_id = so.tenant_id
         JOIN items i
           ON i.id = sol.item_id
          AND i.tenant_id = sol.tenant_id
        WHERE so.tenant_id = $1
          AND so.so_number = $2`,
      [tenantId, DEMO_SO.number]
    ),
    pool.query(
      `SELECT COALESCE(SUM(ssl.quantity_shipped), 0)::numeric AS quantity_shipped
         FROM sales_order_shipments s
         JOIN sales_order_shipment_lines ssl
           ON ssl.sales_order_shipment_id = s.id
          AND ssl.tenant_id = s.tenant_id
        WHERE s.tenant_id = $1
          AND s.external_ref = $2`,
      [tenantId, DEMO_FLOW_IDS.shipmentExternalRef]
    )
  ]);
  return { items: items.rows, bom: bom.rows, po: po.rows, so: so.rows, shipped: shipped.rows[0] };
}

function expectedRequirementBySku() {
  return new Map(
    DEMO_BOM_COMPONENTS.map((component) => [
      component.sku,
      { quantity: component.quantityPer * DEMO_FLOW_QUANTITY, uom: component.uom, per: component.quantityPer }
    ])
  );
}

test('manual Siamaya chocolate seed creates focused prerequisite state only', { timeout: 240000 }, async () => {
  await ensureTestServer();
  const pool = getDbPool();
  const tenantSlug = TEST_TENANT_SLUG;

  await runChocolateSeed(seedConfig('manual', tenantSlug));
  await runChocolateSeed(seedConfig('manual', tenantSlug));

  const tenantId = await tenantIdForSlug(pool, tenantSlug);
  const state = await readManualSeedState(pool, tenantId);
  assert.deepEqual(state.items.map((row) => row.sku), [...DEMO_SKUS].sort());

  const finished = state.items.find((row) => row.sku === DEMO_FINISHED_GOOD.sku);
  assert.equal(finished.type, 'finished');
  assert.equal(finished.default_uom, 'each');
  assert.equal(finished.canonical_uom, 'each');
  assert.equal(finished.stocking_uom, 'each');
  assert.equal(finished.is_purchasable, false);
  assert.equal(finished.is_manufactured, true);

  assert.equal(state.bom.length, DEMO_BOM_COMPONENTS.length);
  assert.ok(state.bom.every((row) => row.bom_code === DEMO_BOM_CODE));
  assert.ok(state.bom.every((row) => row.status === 'active'));
  assert.ok(state.bom.every((row) => Number(row.yield_quantity) === 1));
  assert.ok(state.bom.every((row) => row.yield_uom === 'each'));

  const expected = expectedRequirementBySku();
  let massPerBar = 0;
  for (const row of state.bom) {
    const spec = expected.get(row.sku);
    assert.ok(spec, `unexpected BOM component ${row.sku}`);
    assert.equal(Number(row.component_quantity), spec.per);
    assert.equal(row.component_uom, spec.uom);
    if (row.component_uom === 'g') massPerBar += Number(row.component_quantity);
  }
  assert.equal(massPerBar, 75);
  assert.equal(Number(state.bom.find((row) => row.sku === 'SIAMAYA-MILK-CHOC-FOIL-WRAPPER').component_quantity), 1);

  assert.equal(state.po.length, DEMO_BOM_COMPONENTS.length);
  for (const row of state.po) {
    const spec = expected.get(row.sku);
    assert.ok(spec, `unexpected PO component ${row.sku}`);
    assert.equal(Number(row.quantity_ordered), spec.quantity);
    assert.equal(row.uom, spec.uom);
  }

  assert.equal(state.so.length, 1);
  assert.equal(state.so[0].code, DEMO_CUSTOMER.code);
  assert.equal(state.so[0].sku, DEMO_FINISHED_GOOD.sku);
  assert.equal(Number(state.so[0].quantity_ordered), DEMO_FLOW_QUANTITY);
  assert.equal(state.so[0].uom, 'each');
  assert.equal(Number(state.shipped.quantity_shipped), 0);
});

test('completed Siamaya chocolate seed ships 1,000 bars without negative stock', { timeout: 300000 }, async () => {
  await ensureTestServer();
  const pool = getDbPool();
  const tenantSlug = TEST_TENANT_SLUG;

  await runChocolateSeed(seedConfig('completed', tenantSlug));
  await runChocolateSeed(seedConfig('completed', tenantSlug));

  const tenantId = await tenantIdForSlug(pool, tenantSlug);
  const result = await pool.query(
    `WITH finished AS (
       SELECT id FROM items WHERE tenant_id = $1 AND sku = $2
     ),
     shipment AS (
       SELECT s.id
         FROM sales_order_shipments s
        WHERE s.tenant_id = $1
          AND s.external_ref = $3
     )
     SELECT
       (SELECT COALESCE(SUM(ssl.quantity_shipped), 0)::numeric
          FROM sales_order_shipment_lines ssl
          JOIN shipment s ON s.id = ssl.sales_order_shipment_id
          JOIN sales_order_lines sol ON sol.id = ssl.sales_order_line_id AND sol.tenant_id = ssl.tenant_id
          JOIN finished f ON f.id = sol.item_id
         WHERE ssl.tenant_id = $1) AS shipped_qty,
       (SELECT COUNT(*)::int
          FROM inventory_balance
         WHERE tenant_id = $1
           AND on_hand < -0.000001) AS negative_balance_count,
       (SELECT COUNT(*)::int
          FROM inventory_backorders
         WHERE tenant_id = $1
           AND status NOT IN ('fulfilled', 'cancelled', 'canceled')) AS open_backorder_count,
       (SELECT COUNT(*)::int
          FROM inventory_movement_lines iml
          JOIN inventory_movements im ON im.id = iml.movement_id AND im.tenant_id = iml.tenant_id
         WHERE iml.tenant_id = $1
           AND im.source_type = 'work_order_batch_post_issue') AS consumed_line_count`,
    [tenantId, DEMO_FINISHED_GOOD.sku, DEMO_FLOW_IDS.shipmentExternalRef]
  );
  const row = result.rows[0];
  assert.equal(Number(row.shipped_qty), DEMO_FLOW_QUANTITY);
  assert.equal(Number(row.negative_balance_count), 0);
  assert.equal(Number(row.open_backorder_count), 0);
  assert.equal(Number(row.consumed_line_count), DEMO_BOM_COMPONENTS.length);
});
