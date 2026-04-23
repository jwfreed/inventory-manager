/**
 * WP8 — MRP Planning Contract Tests
 *
 * Tests A–G verify the minimal MRP planning layer:
 *   A. No supply generated when inventory is sufficient
 *   B. Shortage generates planned supply
 *   C. HOLD inventory is not counted as available supply
 *   D. QA/REJECT inventory is not counted as available supply
 *   E. Multiple demands consume inventory FIFO (by date order)
 *   F. Planning is idempotent — same inputs produce same outputs
 *   G. Planning does NOT create inventory movements
 *
 * Invariants verified:
 *   - Planning never writes to inventory_movements or inventory_movement_lines
 *   - Only AVAILABLE (sellable) inventory is consumed in-simulation
 *   - Planned supply is advisory only (mrp_planned_orders)
 *   - computeMrpRun is repeatable (DELETE+INSERT idempotency)
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
  createMrpGrossRequirements,
  computeMrpRun,
  loadSalesOrderDemandIntoRun,
  listMrpPlanLines,
  listMrpPlannedOrders,
} = require('../../src/services/planning.service.ts');

// ── Helper: create a minimal MPS plan + MRP run ───────────────────────────────

async function setupRun(tenantId, { startsOn = '2026-06-01', endsOn = '2026-09-30' } = {}) {
  const plan = await createMpsPlan(tenantId, {
    code: `PLAN-${randomUUID().slice(0, 8)}`,
    bucketType: 'day',
    startsOn,
    endsOn,
  });
  const run = await createMrpRun(tenantId, {
    mpsPlanId: plan.id,
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

async function countMovements(pool, tenantId) {
  const res = await pool.query(
    'SELECT COUNT(*)::int AS cnt FROM inventory_movements WHERE tenant_id = $1',
    [tenantId],
  );
  return res.rows[0].cnt;
}

// ── Test A: no supply when inventory sufficient ───────────────────────────────

test('A. no planned supply when on-hand available exceeds gross requirements', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-a',
    tenantName: 'MRP Test A',
  });
  const { tenantId, topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-A',
    type: 'raw',
  });

  // Seed 20 units in SELLABLE location (counts as available).
  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 20,
    unitCost: 5,
  });

  const { run } = await setupRun(tenantId);

  // Demand: 10 units on 2026-06-01 (on-hand 20 > demand 10 → no shortage).
  await seedGrossRequirements(tenantId, run.id, [
    { itemId: item.id, uom: 'each', periodStart: '2026-06-01', sourceType: 'mps', quantity: 10 },
  ]);

  const result = await computeMrpRun(tenantId, run.id);

  assert.equal(result.planLinesCreated, 1, 'one plan line should be created');
  assert.equal(result.plannedOrdersCreated, 0, 'no planned orders when inventory sufficient');

  const planLines = await listMrpPlanLines(tenantId, run.id);
  assert.equal(planLines.length, 1);
  assert.equal(Number(planLines[0].net_requirements_qty), 0, 'net requirement must be zero');
  assert.equal(Number(planLines[0].planned_order_receipt_qty), 0, 'no planned receipt');

  const orders = await listMrpPlannedOrders(tenantId, run.id);
  assert.equal(orders.length, 0, 'no planned orders');
});

// ── Test B: shortage generates planned supply ─────────────────────────────────

test('B. shortage generates a planned order equal to the net requirement', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-b',
    tenantName: 'MRP Test B',
  });
  const { tenantId, topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-B',
    type: 'raw',
  });

  // Only 3 units available; demand is 10 → shortage of 7.
  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 3,
    unitCost: 5,
  });

  const { run } = await setupRun(tenantId);
  await seedGrossRequirements(tenantId, run.id, [
    { itemId: item.id, uom: 'each', periodStart: '2026-06-01', sourceType: 'mps', quantity: 10 },
  ]);

  const result = await computeMrpRun(tenantId, run.id);

  assert.equal(result.plannedOrdersCreated, 1, 'one planned order for shortage');

  const orders = await listMrpPlannedOrders(tenantId, run.id);
  assert.equal(orders.length, 1);
  assert.equal(Number(orders[0].quantity), 7, 'planned qty = demand - available = 10 - 3 = 7');
  assert.equal(orders[0].order_type, 'planned_purchase_order', 'non-manufactured item → purchase order');
  assert.equal(orders[0].receipt_date, '2026-06-01', 'receipt date = demand period');
  assert.equal(orders[0].release_date, '2026-06-01', 'release date = receipt date when lead time = 0');

  const planLines = await listMrpPlanLines(tenantId, run.id);
  assert.equal(Number(planLines[0].net_requirements_qty), 7);
  assert.equal(Number(planLines[0].planned_order_receipt_qty), 7);
});

// ── Test C: HOLD inventory is ignored ────────────────────────────────────────

test('C. stock in HOLD location is not counted as available supply', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-c',
    tenantName: 'MRP Test C',
  });
  const { tenantId, topology } = harness;

  // Item with NO sellable stock.
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-C',
    type: 'raw',
  });

  // Seed 100 units in HOLD location — these must NOT count as available.
  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.HOLD.id,
    quantity: 100,
    unitCost: 5,
  });

  const { run } = await setupRun(tenantId);
  await seedGrossRequirements(tenantId, run.id, [
    { itemId: item.id, uom: 'each', periodStart: '2026-06-01', sourceType: 'mps', quantity: 8 },
  ]);

  const result = await computeMrpRun(tenantId, run.id);

  // HOLD inventory is NOT sellable; available_qty from sellable view = 0.
  // Net requirement = 8 - 0 = 8 → planned order must be created.
  assert.equal(result.plannedOrdersCreated, 1, 'shortage planned because HOLD stock is excluded');

  const orders = await listMrpPlannedOrders(tenantId, run.id);
  assert.equal(Number(orders[0].quantity), 8, 'full demand quantity unmet because HOLD stock not usable');
});

// ── Test D: QA / REJECT inventory is ignored ─────────────────────────────────

test('D. stock in QA and REJECT locations is not counted as available supply', async () => {
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

  // 50 in QA, 50 in REJECT — neither counts as sellable available.
  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.QA.id,
    quantity: 50,
    unitCost: 5,
  });
  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.REJECT.id,
    quantity: 50,
    unitCost: 5,
  });

  const { run } = await setupRun(tenantId);
  await seedGrossRequirements(tenantId, run.id, [
    { itemId: item.id, uom: 'each', periodStart: '2026-06-01', sourceType: 'mps', quantity: 12 },
  ]);

  await computeMrpRun(tenantId, run.id);

  const orders = await listMrpPlannedOrders(tenantId, run.id);
  assert.equal(orders.length, 1, 'planned order created — QA/REJECT stock not available');
  assert.equal(Number(orders[0].quantity), 12, 'full demand unmet');
});

// ── Test E: multiple demands consume available inventory in date order ─────────

test('E. multiple demand periods consume available inventory carry-forward in date order', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-e',
    tenantName: 'MRP Test E',
  });
  const { tenantId, topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-E',
    type: 'raw',
  });

  // 8 units available.
  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 8,
    unitCost: 5,
  });

  const { run } = await setupRun(tenantId);
  // Demand: 5 on June 1, then 6 on June 15.
  // Period 1: begin=8, demand=5 → end=3, no order needed.
  // Period 2: begin=3, demand=6 → net=3 → order=3.
  await seedGrossRequirements(tenantId, run.id, [
    { itemId: item.id, uom: 'each', periodStart: '2026-06-01', sourceType: 'mps', quantity: 5 },
    { itemId: item.id, uom: 'each', periodStart: '2026-06-15', sourceType: 'mps', quantity: 6 },
  ]);

  await computeMrpRun(tenantId, run.id);

  const orders = await listMrpPlannedOrders(tenantId, run.id);
  assert.equal(orders.length, 1, 'only one period needs a planned order');
  assert.equal(orders[0].receipt_date, '2026-06-15', 'shortage in second period');
  assert.equal(Number(orders[0].quantity), 3, 'net req = demand(6) - carry-forward(3) = 3');

  const planLines = await listMrpPlanLines(tenantId, run.id);
  const sortedLines = [...planLines].sort((a, b) => a.period_start < b.period_start ? -1 : 1);
  assert.equal(Number(sortedLines[0].projected_end_on_hand_qty), 3, 'end of period 1 = 8 - 5 = 3');
  assert.equal(Number(sortedLines[1].begin_on_hand_qty), 3, 'period 2 begins with carry-forward of 3');
  assert.equal(Number(sortedLines[1].net_requirements_qty), 3, 'net req in period 2 = 3');
});

// ── Test F: idempotent planning ───────────────────────────────────────────────

test('F. planning is idempotent — running compute twice yields identical plan lines', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'mrp-f',
    tenantName: 'MRP Test F',
  });
  const { tenantId, topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'MRP-F',
    type: 'raw',
  });
  await harness.seedStockViaCount({
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 4,
    unitCost: 5,
  });

  const { run } = await setupRun(tenantId);
  await seedGrossRequirements(tenantId, run.id, [
    { itemId: item.id, uom: 'each', periodStart: '2026-06-01', sourceType: 'mps', quantity: 10 },
  ]);

  // First run.
  const result1 = await computeMrpRun(tenantId, run.id);
  const orders1 = await listMrpPlannedOrders(tenantId, run.id);
  const lines1 = await listMrpPlanLines(tenantId, run.id);

  // Second run (same inputs → same outputs).
  const result2 = await computeMrpRun(tenantId, run.id);
  const orders2 = await listMrpPlannedOrders(tenantId, run.id);
  const lines2 = await listMrpPlanLines(tenantId, run.id);

  assert.equal(result1.plannedOrdersCreated, result2.plannedOrdersCreated, 'planned order count stable');
  assert.equal(result1.planLinesCreated, result2.planLinesCreated, 'plan line count stable');
  assert.equal(orders2.length, orders1.length, 'no duplicate planned orders');
  assert.equal(lines2.length, lines1.length, 'no duplicate plan lines');
  assert.equal(
    Number(orders2[0].quantity),
    Number(orders1[0].quantity),
    'planned qty identical on rerun',
  );
});

// ── Test G: planning does NOT create inventory movements ──────────────────────

test('G. computeMrpRun does not create any inventory movements', async () => {
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
    quantity: 2,
    unitCost: 5,
  });

  const movementsBefore = await countMovements(pool, tenantId);

  const { run } = await setupRun(tenantId);
  await seedGrossRequirements(tenantId, run.id, [
    { itemId: item.id, uom: 'each', periodStart: '2026-06-01', sourceType: 'mps', quantity: 15 },
    { itemId: item.id, uom: 'each', periodStart: '2026-07-01', sourceType: 'mps', quantity: 10 },
  ]);

  await computeMrpRun(tenantId, run.id);

  const movementsAfter = await countMovements(pool, tenantId);
  assert.equal(
    movementsAfter,
    movementsBefore,
    'computeMrpRun must not write any inventory movements',
  );

  // Planned orders do exist.
  const orders = await listMrpPlannedOrders(tenantId, run.id);
  assert.ok(orders.length > 0, 'planned orders created as advisory supply');
});
