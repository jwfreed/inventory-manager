/**
 * WP8 — MRP Planning Contract Tests
 *
 * A. location-level planning correctness
 * B. MPS vs SO demand isolation
 * C. combined mode without duplication
 * D. safety stock enforcement
 * E. multi-location independence
 * F. idempotent recompute
 * G. no inventory mutation
 * H. planned order lifecycle transitions
 * I. multi-period conservation across locations
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServiceHarness } from '../helpers/service-harness.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  createMpsPlan,
  createMrpRun,
  createMrpItemPolicies,
  createMrpGrossRequirements,
  computeMrpRun,
  loadSalesOrderDemandIntoRun,
  listMrpPlanLines,
  listMrpPlannedOrders,
  firmPlannedOrder,
  releasePlannedOrder,
} = require('../../src/services/planning.service.ts');

async function setupRun(
  tenantId,
  {
    demandMode = 'mps_only',
    startsOn = '2026-06-01',
    endsOn = '2026-09-30',
  } = {},
) {
  const plan = await createMpsPlan(tenantId, {
    code: `PLAN-${randomUUID().slice(0, 8)}`,
    bucketType: 'day',
    startsOn,
    endsOn,
  });
  const run = await createMrpRun(tenantId, {
    mpsPlanId: plan.id,
    demandMode,
    asOf: new Date().toISOString(),
    bucketType: 'day',
    startsOn,
    endsOn,
  });
  return { plan, run };
}

async function seedGrossRequirements(tenantId, runId, requirements) {
  return createMrpGrossRequirements(tenantId, runId, { requirements });
}

async function seedItemPolicies(tenantId, runId, policies) {
  return createMrpItemPolicies(tenantId, runId, { policies });
}

async function insertGrossRequirementRow(pool, tenantId, runId, requirement) {
  await pool.query(
    `INSERT INTO mrp_gross_requirements (
       id, tenant_id, mrp_run_id, item_id, uom, site_location_id,
       period_start, source_type, source_ref, quantity, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
    [
      randomUUID(),
      tenantId,
      runId,
      requirement.itemId,
      requirement.uom,
      requirement.siteLocationId,
      requirement.periodStart,
      requirement.sourceType,
      requirement.sourceRef ?? null,
      requirement.quantity,
    ],
  );
}

async function insertScheduledReceiptRow(pool, tenantId, runId, receipt) {
  await pool.query(
    `INSERT INTO mrp_scheduled_receipts (
       id, tenant_id, mrp_run_id, item_id, uom, site_location_id,
       period_start, source_type, source_ref, quantity, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
    [
      randomUUID(),
      tenantId,
      runId,
      receipt.itemId,
      receipt.uom,
      receipt.siteLocationId,
      receipt.periodStart,
      receipt.sourceType,
      receipt.sourceRef ?? null,
      receipt.quantity,
    ],
  );
}

async function countMovements(pool, tenantId) {
  const res = await pool.query(
    'SELECT COUNT(*)::int AS cnt FROM inventory_movements WHERE tenant_id = $1',
    [tenantId],
  );
  return res.rows[0].cnt;
}

async function countGrossRequirements(pool, tenantId, runId) {
  const res = await pool.query(
    'SELECT COUNT(*)::int AS cnt FROM mrp_gross_requirements WHERE tenant_id = $1 AND mrp_run_id = $2',
    [tenantId, runId],
  );
  return res.rows[0].cnt;
}

async function createSalesDemandOrder(
  harness,
  { itemId, locationId, warehouseId, quantity, requestedShipDate = '2026-06-01' },
) {
  const customer = await harness.createCustomer('MRP');
  const order = await harness.createSalesOrder({
    soNumber: `SO-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    warehouseId,
    status: 'submitted',
    requestedShipDate,
    shipFromLocationId: locationId,
    lines: [
      {
        itemId,
        uom: 'each',
        quantityOrdered: quantity,
      },
    ],
  });
  return {
    order,
    lineId: order.lines[0].id,
  };
}

function findPlanLine(lines, locationId, periodStart) {
  return lines.find((line) => line.site_location_id === locationId && line.period_start === periodStart);
}

function sortOrders(orders) {
  return [...orders].sort((left, right) => {
    const receipt = String(left.receipt_date).localeCompare(String(right.receipt_date));
    if (receipt !== 0) return receipt;
    return String(left.site_location_id).localeCompare(String(right.site_location_id));
  });
}

test('A. planning uses only matching SELLABLE location inventory and does not aggregate across locations', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-a',
    tenantName: 'MRP Test A',
  });
  const { tenantId, topology } = harness;
  const overflow = await harness.createWarehouseWithSellable('MRP-A-OVERFLOW');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-A',
    type: 'raw',
  });

  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 3,
    unitCost: 5,
  });
  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.HOLD.id,
    quantity: 50,
    unitCost: 5,
  });
  await harness.seedStockViaCount({
    warehouseId: overflow.warehouse.id,
    itemId: item.id,
    locationId: overflow.sellable.id,
    quantity: 20,
    unitCost: 5,
  });

  const { run } = await setupRun(tenantId);
  await seedGrossRequirements(tenantId, run.id, [
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: topology.defaults.SELLABLE.id,
      periodStart: '2026-06-01',
      sourceType: 'mps',
      sourceRef: 'mps-a-1',
      quantity: 5,
    },
  ]);

  const result = await computeMrpRun(tenantId, run.id);
  assert.equal(result.planLinesCreated, 1);
  assert.equal(result.plannedOrdersCreated, 1);

  const line = (await listMrpPlanLines(tenantId, run.id))[0];
  assert.equal(line.site_location_id, topology.defaults.SELLABLE.id);
  assert.equal(Number(line.begin_on_hand_qty), 3, 'only matching sellable stock is usable');
  assert.equal(Number(line.net_requirements_qty), 2, 'overflow and HOLD stock must not satisfy local demand');
  assert.equal(Number(line.planned_order_receipt_qty), 2);
});

test('B. demand_mode isolates MPS and sales-order demand sources', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-b',
    tenantName: 'MRP Test B',
  });
  const { tenantId, topology, pool } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-B',
    type: 'raw',
  });

  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 2,
    unitCost: 5,
  });

  const { run: mpsOnlyRun } = await setupRun(tenantId, { demandMode: 'mps_only' });
  await seedGrossRequirements(tenantId, mpsOnlyRun.id, [
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: topology.defaults.SELLABLE.id,
      periodStart: '2026-06-01',
      sourceType: 'mps',
      sourceRef: 'mps-b-1',
      quantity: 4,
    },
  ]);
  await insertGrossRequirementRow(pool, tenantId, mpsOnlyRun.id, {
    itemId: item.id,
    uom: 'each',
    siteLocationId: topology.defaults.SELLABLE.id,
    periodStart: '2026-06-01',
    sourceType: 'sales_orders',
    sourceRef: 'so-b-legacy',
    quantity: 100,
  });
  await computeMrpRun(tenantId, mpsOnlyRun.id);
  const mpsOnlyLine = (await listMrpPlanLines(tenantId, mpsOnlyRun.id))[0];
  assert.equal(Number(mpsOnlyLine.gross_requirements_qty), 4, 'mps_only ignores sales-order demand');
  assert.equal(Number(mpsOnlyLine.net_requirements_qty), 2);

  const { run: soOnlyRun } = await setupRun(tenantId, { demandMode: 'sales_orders_only' });
  await insertGrossRequirementRow(pool, tenantId, soOnlyRun.id, {
    itemId: item.id,
    uom: 'each',
    siteLocationId: topology.defaults.SELLABLE.id,
    periodStart: '2026-06-01',
    sourceType: 'mps',
    sourceRef: 'mps-b-legacy',
    quantity: 100,
  });
  await insertGrossRequirementRow(pool, tenantId, soOnlyRun.id, {
    itemId: item.id,
    uom: 'each',
    siteLocationId: topology.defaults.SELLABLE.id,
    periodStart: '2026-06-01',
    sourceType: 'sales_orders',
    sourceRef: 'so-b-1',
    quantity: 4,
  });
  await computeMrpRun(tenantId, soOnlyRun.id);
  const soOnlyLine = (await listMrpPlanLines(tenantId, soOnlyRun.id))[0];
  assert.equal(Number(soOnlyLine.gross_requirements_qty), 4, 'sales_orders_only ignores MPS demand');
  assert.equal(Number(soOnlyLine.net_requirements_qty), 2);
});

test('C. combined demand mode sums distinct sources and rejects duplicate source_ref overlap', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-c',
    tenantName: 'MRP Test C',
  });
  const { tenantId, topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-C',
    type: 'raw',
  });

  const { run } = await setupRun(tenantId, { demandMode: 'combined' });
  await seedGrossRequirements(tenantId, run.id, [
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: topology.defaults.SELLABLE.id,
      periodStart: '2026-06-01',
      sourceType: 'mps',
      sourceRef: 'mps-c-1',
      quantity: 3,
    },
  ]);

  const salesOrder = await createSalesDemandOrder(harness, {
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    warehouseId: topology.warehouse.id,
    quantity: 5,
  });
  const loadResult = await loadSalesOrderDemandIntoRun(tenantId, run.id);
  assert.equal(loadResult.loadedCount, 1);

  await assert.rejects(
    () =>
      seedGrossRequirements(tenantId, run.id, [
        {
          itemId: item.id,
          uom: 'each',
          siteLocationId: topology.defaults.SELLABLE.id,
          periodStart: '2026-06-01',
          sourceType: 'mps',
          sourceRef: salesOrder.lineId,
          quantity: 1,
        },
      ]),
    /MRP_DUPLICATE_DEMAND_SOURCE_REF/,
  );

  await computeMrpRun(tenantId, run.id);
  const line = (await listMrpPlanLines(tenantId, run.id))[0];
  assert.equal(Number(line.gross_requirements_qty), 8, 'combined mode sums distinct MPS and SO demand');
  assert.equal(Number(line.planned_order_receipt_qty), 8);
});

test('D. safety stock acts as a projected end-on-hand floor', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-d',
    tenantName: 'MRP Test D',
  });
  const { tenantId, topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-D',
    type: 'raw',
  });

  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 3,
    unitCost: 5,
  });

  const { run } = await setupRun(tenantId);
  await seedItemPolicies(tenantId, run.id, [
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: topology.defaults.SELLABLE.id,
      safetyStockQty: 5,
      lotSizingMethod: 'l4l',
    },
  ]);
  await seedGrossRequirements(tenantId, run.id, [
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: topology.defaults.SELLABLE.id,
      periodStart: '2026-06-01',
      sourceType: 'mps',
      sourceRef: 'mps-d-1',
      quantity: 2,
    },
  ]);

  await computeMrpRun(tenantId, run.id);
  const line = (await listMrpPlanLines(tenantId, run.id))[0];
  assert.equal(Number(line.net_requirements_qty), 4, 'net = gross + safety - begin');
  assert.equal(Number(line.planned_order_receipt_qty), 4);
  assert.equal(Number(line.projected_end_on_hand_qty), 5, 'projected end on hand must meet safety stock');
});

test('D1. quiet horizon buckets without gross demand still replenish to the safety floor', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-d1',
    tenantName: 'MRP Test D1',
  });
  const { tenantId, topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-D1',
    type: 'raw',
  });

  const { run } = await setupRun(tenantId, {
    startsOn: '2026-06-01',
    endsOn: '2026-06-03',
  });
  await seedItemPolicies(tenantId, run.id, [
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: topology.defaults.SELLABLE.id,
      safetyStockQty: 5,
      lotSizingMethod: 'l4l',
    },
  ]);

  const result = await computeMrpRun(tenantId, run.id);
  const lines = await listMrpPlanLines(tenantId, run.id);
  const orders = await listMrpPlannedOrders(tenantId, run.id);

  assert.equal(result.planLinesCreated, 1);
  assert.equal(result.plannedOrdersCreated, 1);
  assert.equal(lines.length, 1, 'the first quiet bucket must still be evaluated');
  assert.equal(lines[0].period_start, '2026-06-01');
  assert.equal(Number(lines[0].gross_requirements_qty), 0);
  assert.equal(Number(lines[0].net_requirements_qty), 5);
  assert.equal(Number(lines[0].projected_end_on_hand_qty), 5);
  assert.equal(orders[0].receipt_date, '2026-06-01');
  assert.equal(Number(orders[0].quantity), 5);
});

test('D2. scheduled-receipt-only scopes are evaluated even without gross demand rows', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-d2',
    tenantName: 'MRP Test D2',
  });
  const { tenantId, topology, pool } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-D2',
    type: 'raw',
  });

  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 5,
  });

  const { run } = await setupRun(tenantId, {
    startsOn: '2026-06-01',
    endsOn: '2026-06-03',
  });
  await seedItemPolicies(tenantId, run.id, [
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: topology.defaults.SELLABLE.id,
      safetyStockQty: 5,
      lotSizingMethod: 'l4l',
    },
  ]);
  await insertScheduledReceiptRow(pool, tenantId, run.id, {
    itemId: item.id,
    uom: 'each',
    siteLocationId: topology.defaults.SELLABLE.id,
    periodStart: '2026-06-02',
    sourceType: 'purchase_orders',
    sourceRef: 'po-d2-1',
    quantity: 1,
  });

  const result = await computeMrpRun(tenantId, run.id);
  const lines = await listMrpPlanLines(tenantId, run.id);

  assert.equal(result.planLinesCreated, 1, 'scheduled receipt scope should not be skipped');
  assert.equal(result.plannedOrdersCreated, 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].period_start, '2026-06-02');
  assert.equal(Number(lines[0].gross_requirements_qty), 0);
  assert.equal(Number(lines[0].scheduled_receipts_qty), 1);
  assert.equal(Number(lines[0].net_requirements_qty), 0);
  assert.equal(Number(lines[0].projected_end_on_hand_qty), 6);
});

test('D3. zero-demand horizons still replenish to safety stock when policy requires it', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-d3',
    tenantName: 'MRP Test D3',
  });
  const { tenantId, topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-D3',
    type: 'raw',
  });

  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 2,
    unitCost: 5,
  });

  const { run } = await setupRun(tenantId, {
    startsOn: '2026-06-01',
    endsOn: '2026-06-04',
  });
  await seedItemPolicies(tenantId, run.id, [
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: topology.defaults.SELLABLE.id,
      safetyStockQty: 5,
      lotSizingMethod: 'l4l',
    },
  ]);

  await computeMrpRun(tenantId, run.id);
  const lines = await listMrpPlanLines(tenantId, run.id);
  const orders = await listMrpPlannedOrders(tenantId, run.id);

  assert.equal(lines.length, 1, 'the first horizon bucket should replenish to safety and later quiet buckets stay implicit');
  assert.equal(lines[0].period_start, '2026-06-01');
  assert.equal(Number(lines[0].begin_on_hand_qty), 2);
  assert.equal(Number(lines[0].planned_order_receipt_qty), 3);
  assert.equal(Number(lines[0].projected_end_on_hand_qty), 5);
  assert.equal(orders.length, 1);
  assert.equal(Number(orders[0].quantity), 3);
});

test('D4. later demand after a quiet period uses carry-forward from the safety-stock replenishment bucket', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-d4',
    tenantName: 'MRP Test D4',
  });
  const { tenantId, topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-D4',
    type: 'raw',
  });

  const { run } = await setupRun(tenantId, {
    startsOn: '2026-06-01',
    endsOn: '2026-06-03',
  });
  await seedItemPolicies(tenantId, run.id, [
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: topology.defaults.SELLABLE.id,
      safetyStockQty: 5,
      lotSizingMethod: 'l4l',
    },
  ]);
  await seedGrossRequirements(tenantId, run.id, [
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: topology.defaults.SELLABLE.id,
      periodStart: '2026-06-03',
      sourceType: 'mps',
      sourceRef: 'mps-d4-1',
      quantity: 6,
    },
  ]);

  await computeMrpRun(tenantId, run.id);
  const lines = await listMrpPlanLines(tenantId, run.id);
  const quietBucket = findPlanLine(lines, topology.defaults.SELLABLE.id, '2026-06-01');
  const demandBucket = findPlanLine(lines, topology.defaults.SELLABLE.id, '2026-06-03');

  assert.equal(lines.length, 2, 'the quiet replenishment bucket and later demand bucket should both persist');
  assert.equal(Number(quietBucket.projected_end_on_hand_qty), 5);
  assert.equal(Number(demandBucket.begin_on_hand_qty), 5, 'later demand must inherit the quiet-bucket projected balance');
  assert.equal(Number(demandBucket.net_requirements_qty), 6);
  assert.equal(Number(demandBucket.projected_end_on_hand_qty), 5);
});

test('E. planning remains independent per location when the same item is demanded in multiple locations', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-e',
    tenantName: 'MRP Test E',
  });
  const { tenantId, topology } = harness;
  const secondary = await harness.createWarehouseWithSellable('MRP-E-SECONDARY');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-E',
    type: 'raw',
  });

  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 4,
    unitCost: 5,
  });
  await harness.seedStockViaCount({
    warehouseId: secondary.warehouse.id,
    itemId: item.id,
    locationId: secondary.sellable.id,
    quantity: 9,
    unitCost: 5,
  });

  const { run } = await setupRun(tenantId);
  await seedGrossRequirements(tenantId, run.id, [
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: topology.defaults.SELLABLE.id,
      periodStart: '2026-06-01',
      sourceType: 'mps',
      sourceRef: 'mps-e-a',
      quantity: 8,
    },
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: secondary.sellable.id,
      periodStart: '2026-06-01',
      sourceType: 'mps',
      sourceRef: 'mps-e-b',
      quantity: 1,
    },
  ]);

  await computeMrpRun(tenantId, run.id);
  const lines = await listMrpPlanLines(tenantId, run.id);
  const primaryLine = findPlanLine(lines, topology.defaults.SELLABLE.id, '2026-06-01');
  const secondaryLine = findPlanLine(lines, secondary.sellable.id, '2026-06-01');

  assert.equal(Number(primaryLine.begin_on_hand_qty), 4);
  assert.equal(Number(primaryLine.net_requirements_qty), 4, 'primary shortage stays local');
  assert.equal(Number(secondaryLine.begin_on_hand_qty), 9);
  assert.equal(Number(secondaryLine.net_requirements_qty), 0, 'secondary surplus does not cross-net to primary');
});

test('F. demand loading and recompute are idempotent', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-f',
    tenantName: 'MRP Test F',
  });
  const { tenantId, topology, pool } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-F',
    type: 'raw',
  });

  const { run } = await setupRun(tenantId, { demandMode: 'sales_orders_only' });
  await createSalesDemandOrder(harness, {
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    warehouseId: topology.warehouse.id,
    quantity: 6,
  });

  const load1 = await loadSalesOrderDemandIntoRun(tenantId, run.id);
  const grossCount1 = await countGrossRequirements(pool, tenantId, run.id);
  const load2 = await loadSalesOrderDemandIntoRun(tenantId, run.id);
  const grossCount2 = await countGrossRequirements(pool, tenantId, run.id);

  assert.equal(load1.loadedCount, 1);
  assert.equal(load2.loadedCount, 1);
  assert.equal(grossCount1, 1);
  assert.equal(grossCount2, 1, 'reloading sales demand must replace, not duplicate');

  const result1 = await computeMrpRun(tenantId, run.id);
  const orders1 = await listMrpPlannedOrders(tenantId, run.id);
  const lines1 = await listMrpPlanLines(tenantId, run.id);

  const result2 = await computeMrpRun(tenantId, run.id);
  const orders2 = await listMrpPlannedOrders(tenantId, run.id);
  const lines2 = await listMrpPlanLines(tenantId, run.id);

  assert.equal(result1.planLinesCreated, result2.planLinesCreated);
  assert.equal(result1.plannedOrdersCreated, result2.plannedOrdersCreated);
  assert.equal(orders1.length, orders2.length);
  assert.equal(lines1.length, lines2.length);
  assert.equal(Number(orders1[0].quantity), Number(orders2[0].quantity));
});

test('G. computeMrpRun does not create inventory movements or alter stock balances', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-g',
    tenantName: 'MRP Test G',
  });
  const { tenantId, topology, pool } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-G',
    type: 'raw',
  });

  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 1,
    unitCost: 5,
  });

  const movementsBefore = await countMovements(pool, tenantId);
  const onHandBefore = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);

  const { run } = await setupRun(tenantId);
  await seedGrossRequirements(tenantId, run.id, [
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: topology.defaults.SELLABLE.id,
      periodStart: '2026-06-01',
      sourceType: 'mps',
      sourceRef: 'mps-g-1',
      quantity: 10,
    },
  ]);

  await computeMrpRun(tenantId, run.id);

  const movementsAfter = await countMovements(pool, tenantId);
  const onHandAfter = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);
  assert.equal(movementsAfter, movementsBefore, 'planning must not write inventory movements');
  assert.equal(onHandAfter, onHandBefore, 'planning must not change inventory balances');
});

test('G1. safety-stock-only recompute does not create inventory movements or alter stock balances', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-g1',
    tenantName: 'MRP Test G1',
  });
  const { tenantId, topology, pool } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-G1',
    type: 'raw',
  });

  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 2,
    unitCost: 5,
  });

  const movementsBefore = await countMovements(pool, tenantId);
  const onHandBefore = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);

  const { run } = await setupRun(tenantId, {
    startsOn: '2026-06-01',
    endsOn: '2026-06-03',
  });
  await seedItemPolicies(tenantId, run.id, [
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: topology.defaults.SELLABLE.id,
      safetyStockQty: 5,
      lotSizingMethod: 'l4l',
    },
  ]);

  await computeMrpRun(tenantId, run.id);

  const movementsAfter = await countMovements(pool, tenantId);
  const onHandAfter = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);
  assert.equal(movementsAfter, movementsBefore, 'safety-stock planning must not write inventory movements');
  assert.equal(onHandAfter, onHandBefore, 'safety-stock planning must not change inventory balances');
});

test('H. planned orders transition planned -> firmed -> released without execution side effects', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-h',
    tenantName: 'MRP Test H',
  });
  const { tenantId, topology, pool } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-H',
    type: 'raw',
  });

  const { run } = await setupRun(tenantId);
  await seedGrossRequirements(tenantId, run.id, [
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: topology.defaults.SELLABLE.id,
      periodStart: '2026-06-01',
      sourceType: 'mps',
      sourceRef: 'mps-h-1',
      quantity: 5,
    },
  ]);

  await computeMrpRun(tenantId, run.id);
  const [plannedOrder] = await listMrpPlannedOrders(tenantId, run.id);
  assert.equal(plannedOrder.status, 'planned');

  const movementsBefore = await countMovements(pool, tenantId);
  await assert.rejects(() => releasePlannedOrder(tenantId, plannedOrder.id), /MRP_PLANNED_ORDER_INVALID_STATUS/);

  const firmed = await firmPlannedOrder(tenantId, plannedOrder.id);
  assert.equal(firmed.status, 'firmed');

  const released = await releasePlannedOrder(tenantId, plannedOrder.id);
  assert.equal(released.status, 'released');

  const movementsAfter = await countMovements(pool, tenantId);
  assert.equal(movementsAfter, movementsBefore, 'firm/release must not create execution movements');
});

test('I. projected inventory conserves across periods independently by location', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-i',
    tenantName: 'MRP Test I',
  });
  const { tenantId, topology } = harness;
  const secondary = await harness.createWarehouseWithSellable('MRP-I-SECONDARY');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-I',
    type: 'raw',
  });

  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 8,
    unitCost: 5,
  });
  await harness.seedStockViaCount({
    warehouseId: secondary.warehouse.id,
    itemId: item.id,
    locationId: secondary.sellable.id,
    quantity: 2,
    unitCost: 5,
  });

  const { run } = await setupRun(tenantId);
  await seedGrossRequirements(tenantId, run.id, [
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: topology.defaults.SELLABLE.id,
      periodStart: '2026-06-01',
      sourceType: 'mps',
      sourceRef: 'mps-i-a1',
      quantity: 5,
    },
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: topology.defaults.SELLABLE.id,
      periodStart: '2026-06-15',
      sourceType: 'mps',
      sourceRef: 'mps-i-a2',
      quantity: 6,
    },
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: secondary.sellable.id,
      periodStart: '2026-06-01',
      sourceType: 'mps',
      sourceRef: 'mps-i-b1',
      quantity: 1,
    },
    {
      itemId: item.id,
      uom: 'each',
      siteLocationId: secondary.sellable.id,
      periodStart: '2026-06-15',
      sourceType: 'mps',
      sourceRef: 'mps-i-b2',
      quantity: 4,
    },
  ]);

  await computeMrpRun(tenantId, run.id);
  const lines = await listMrpPlanLines(tenantId, run.id);

  const primaryP1 = findPlanLine(lines, topology.defaults.SELLABLE.id, '2026-06-01');
  const primaryP2 = findPlanLine(lines, topology.defaults.SELLABLE.id, '2026-06-15');
  const secondaryP1 = findPlanLine(lines, secondary.sellable.id, '2026-06-01');
  const secondaryP2 = findPlanLine(lines, secondary.sellable.id, '2026-06-15');

  assert.equal(Number(primaryP1.projected_end_on_hand_qty), 3);
  assert.equal(Number(primaryP2.begin_on_hand_qty), 3, 'next period begins from prior projected end');
  assert.equal(Number(primaryP2.net_requirements_qty), 3);

  assert.equal(Number(secondaryP1.projected_end_on_hand_qty), 1);
  assert.equal(Number(secondaryP2.begin_on_hand_qty), 1, 'carry-forward remains location-specific');
  assert.equal(Number(secondaryP2.net_requirements_qty), 3);

  const orders = sortOrders(await listMrpPlannedOrders(tenantId, run.id));
  assert.equal(orders.length, 2, 'one planned order per shortage location/period');
  assert.equal(orders[0].receipt_date, '2026-06-15');
  assert.equal(orders[1].receipt_date, '2026-06-15');
  assert.ok(lines.every((line) => Number(line.projected_end_on_hand_qty) >= 0), 'projected inventory must not go negative');
});
