import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from './helpers/service-harness.mjs';

test('void-report-production posts compensating movements and restores pre-report inventory state', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wo-void-ok',
    tenantName: 'WO Void Happy Tenant'
  });
  const { tenantId, pool: db, topology } = harness;

  const componentA = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'VOID-RAW-A',
    type: 'raw'
  });
  const componentB = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'VOID-RAW-B',
    type: 'raw'
  });
  const outputItem = await harness.createItem({
    defaultLocationId: topology.defaults.QA.id,
    skuPrefix: 'VOID-FG',
    type: 'finished'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: componentA.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 40,
    unitCost: 10
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: componentB.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 20,
    unitCost: 3
  });

  const bom = await harness.createBomAndActivate({
    outputItemId: outputItem.id,
    components: [
      { componentItemId: componentA.id, quantityPer: 2 },
      { componentItemId: componentB.id, quantityPer: 1 }
    ],
    suffix: randomUUID().slice(0, 6)
  });
  const workOrder = await harness.createWorkOrder({
    kind: 'production',
    outputItemId: outputItem.id,
    outputUom: 'each',
    quantityPlanned: 20,
    bomId: bom.id,
    defaultConsumeLocationId: topology.defaults.SELLABLE.id,
    defaultProduceLocationId: topology.defaults.QA.id
  });

  const preA = await harness.readOnHand(componentA.id, topology.defaults.SELLABLE.id);
  const preB = await harness.readOnHand(componentB.id, topology.defaults.SELLABLE.id);
  const preQa = await harness.readOnHand(outputItem.id, topology.defaults.QA.id);

  const reportKey = `wo-void-report:${randomUUID()}`;
  const report = await harness.reportProduction(
    workOrder.id,
    {
      warehouseId: topology.warehouse.id,
      outputQty: 20,
      outputUom: 'each',
      occurredAt: '2026-02-20T00:00:00.000Z',
      idempotencyKey: reportKey
    },
    {},
    { idempotencyKey: reportKey }
  );
  assert.equal(report.replayed, false);
  const reservationsAfterReport = await db.query(
    `SELECT item_id,
            status,
            quantity_reserved::numeric AS quantity_reserved,
            COALESCE(quantity_fulfilled, 0)::numeric AS quantity_fulfilled
       FROM inventory_reservations
      WHERE tenant_id = $1
        AND demand_type = 'work_order_component'
        AND demand_id = $2
      ORDER BY item_id ASC`,
    [tenantId, workOrder.id]
  );
  const normalizeReservations = (rows) => rows.map((row) => ({
    itemId: row.item_id,
    status: row.status,
    reserved: Number(row.quantity_reserved),
    fulfilled: Number(row.quantity_fulfilled)
  })).sort((left, right) => left.itemId.localeCompare(right.itemId));
  assert.deepEqual(
    normalizeReservations(reservationsAfterReport.rows),
    normalizeReservations([
      { item_id: componentA.id, status: 'FULFILLED', quantity_reserved: 40, quantity_fulfilled: 40 },
      { item_id: componentB.id, status: 'FULFILLED', quantity_reserved: 20, quantity_fulfilled: 20 }
    ])
  );

  const voidKey = `wo-void:${randomUUID()}`;
  const firstVoid = await harness.voidProductionReport(
    workOrder.id,
    {
      workOrderExecutionId: report.productionReportId,
      reason: 'test correction',
      idempotencyKey: voidKey
    },
    { type: 'system', id: null },
    { idempotencyKey: voidKey }
  );
  assert.equal(firstVoid.replayed, false);

  const replayVoid = await harness.voidProductionReport(
    workOrder.id,
    {
      workOrderExecutionId: report.productionReportId,
      reason: 'test correction',
      idempotencyKey: voidKey
    },
    { type: 'system', id: null },
    { idempotencyKey: voidKey }
  );
  assert.equal(replayVoid.componentReturnMovementId, firstVoid.componentReturnMovementId);
  assert.equal(replayVoid.outputReversalMovementId, firstVoid.outputReversalMovementId);
  assert.equal(replayVoid.replayed, true);
  const reservationsAfterVoid = await db.query(
    `SELECT item_id,
            status,
            quantity_reserved::numeric AS quantity_reserved,
            COALESCE(quantity_fulfilled, 0)::numeric AS quantity_fulfilled
       FROM inventory_reservations
      WHERE tenant_id = $1
        AND demand_type = 'work_order_component'
        AND demand_id = $2
      ORDER BY item_id ASC`,
    [tenantId, workOrder.id]
  );
  assert.deepEqual(
    normalizeReservations(reservationsAfterVoid.rows),
    normalizeReservations([
      { item_id: componentA.id, status: 'RESERVED', quantity_reserved: 40, quantity_fulfilled: 0 },
      { item_id: componentB.id, status: 'RESERVED', quantity_reserved: 20, quantity_fulfilled: 0 }
    ])
  );
  const restoreAuditCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM audit_log
      WHERE tenant_id = $1
        AND entity_type = 'work_order_execution'
        AND entity_id = $2
        AND action = 'update'
        AND COALESCE(metadata->>'reservationRestore', '') = 'void'`,
    [tenantId, report.productionReportId]
  );
  assert.equal(Number(restoreAuditCount.rows[0]?.count ?? 0), 1);

  const voidMovementCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_id = $2
        AND source_type IN ('work_order_batch_void_components', 'work_order_batch_void_output')`,
    [tenantId, report.productionReportId]
  );
  assert.equal(Number(voidMovementCount.rows[0]?.count ?? 0), 2);

  const postA = await harness.readOnHand(componentA.id, topology.defaults.SELLABLE.id);
  const postB = await harness.readOnHand(componentB.id, topology.defaults.SELLABLE.id);
  const postQa = await harness.readOnHand(outputItem.id, topology.defaults.QA.id);
  assert.ok(Math.abs(postA - preA) < 1e-6, `componentA drift pre=${preA} post=${postA}`);
  assert.ok(Math.abs(postB - preB) < 1e-6, `componentB drift pre=${preB} post=${postB}`);
  assert.ok(Math.abs(postQa - preQa) < 1e-6, `output QA drift pre=${preQa} post=${postQa}`);

  const costSumResult = await db.query(
    `SELECT COALESCE(SUM(
              COALESCE(
                extended_cost,
                COALESCE(unit_cost, 0) * COALESCE(quantity_delta_canonical, quantity_delta)
              )
            ), 0)::numeric AS signed_cost
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = ANY($2::uuid[])`,
    [
      tenantId,
      [
        report.componentIssueMovementId,
        report.productionReceiptMovementId,
        firstVoid.componentReturnMovementId,
        firstVoid.outputReversalMovementId
      ]
    ]
  );
  const signedCost = Number(costSumResult.rows[0]?.signed_cost ?? 0);
  assert.ok(Math.abs(signedCost) < 0.0001, `expected net-zero signed movement cost, got ${signedCost}`);

  await harness.runStrictInvariants();
});

test('void-report-production restores partial reservation fulfillment back to RESERVED exactly once', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wo-void-partial',
    tenantName: 'WO Void Partial Reservation Tenant'
  });
  const { tenantId, pool: db, topology } = harness;

  const component = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'VOID-PARTIAL-RAW',
    type: 'raw'
  });
  const outputItem = await harness.createItem({
    defaultLocationId: topology.defaults.QA.id,
    skuPrefix: 'VOID-PARTIAL-FG',
    type: 'finished'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: component.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 40,
    unitCost: 7
  });

  const bom = await harness.createBomAndActivate({
    outputItemId: outputItem.id,
    components: [{ componentItemId: component.id, quantityPer: 2 }],
    suffix: randomUUID().slice(0, 6)
  });
  const workOrder = await harness.createWorkOrder({
    kind: 'production',
    outputItemId: outputItem.id,
    outputUom: 'each',
    quantityPlanned: 10,
    bomId: bom.id,
    defaultConsumeLocationId: topology.defaults.SELLABLE.id,
    defaultProduceLocationId: topology.defaults.QA.id
  });

  const reportKey = `wo-void-partial-report:${randomUUID()}`;
  const report = await harness.reportProduction(
    workOrder.id,
    {
      warehouseId: topology.warehouse.id,
      outputQty: 4,
      outputUom: 'each',
      occurredAt: '2026-02-21T00:00:00.000Z',
      idempotencyKey: reportKey
    },
    {},
    { idempotencyKey: reportKey }
  );
  const reservationAfterReport = await db.query(
    `SELECT status,
            quantity_reserved::numeric AS quantity_reserved,
            COALESCE(quantity_fulfilled, 0)::numeric AS quantity_fulfilled
       FROM inventory_reservations
      WHERE tenant_id = $1
        AND demand_type = 'work_order_component'
        AND demand_id = $2
        AND item_id = $3`,
    [tenantId, workOrder.id, component.id]
  );
  assert.equal(reservationAfterReport.rows[0]?.status, 'ALLOCATED');
  assert.equal(Number(reservationAfterReport.rows[0]?.quantity_reserved ?? 0), 20);
  assert.equal(Number(reservationAfterReport.rows[0]?.quantity_fulfilled ?? 0), 8);

  const voidKey = `wo-void-partial:${randomUUID()}`;
  await harness.voidProductionReport(
    workOrder.id,
    {
      workOrderExecutionId: report.productionReportId,
      reason: 'partial correction',
      idempotencyKey: voidKey
    },
    { type: 'system', id: null },
    { idempotencyKey: voidKey }
  );
  await harness.voidProductionReport(
    workOrder.id,
    {
      workOrderExecutionId: report.productionReportId,
      reason: 'partial correction',
      idempotencyKey: voidKey
    },
    { type: 'system', id: null },
    { idempotencyKey: voidKey }
  );

  const reservationAfterVoid = await db.query(
    `SELECT status,
            quantity_reserved::numeric AS quantity_reserved,
            COALESCE(quantity_fulfilled, 0)::numeric AS quantity_fulfilled
       FROM inventory_reservations
      WHERE tenant_id = $1
        AND demand_type = 'work_order_component'
        AND demand_id = $2
        AND item_id = $3`,
    [tenantId, workOrder.id, component.id]
  );
  assert.equal(reservationAfterVoid.rows[0]?.status, 'RESERVED');
  assert.equal(Number(reservationAfterVoid.rows[0]?.quantity_reserved ?? 0), 20);
  assert.equal(Number(reservationAfterVoid.rows[0]?.quantity_fulfilled ?? 0), 0);

  const restoreAuditCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM audit_log
      WHERE tenant_id = $1
        AND entity_type = 'work_order_execution'
        AND entity_id = $2
        AND action = 'update'
        AND COALESCE(metadata->>'reservationRestore', '') = 'void'`,
    [tenantId, report.productionReportId]
  );
  assert.equal(Number(restoreAuditCount.rows[0]?.count ?? 0), 1);
});

test('void-report-production skips missing reservation rows and still succeeds', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wo-void-missing-res',
    tenantName: 'WO Void Missing Reservation Tenant'
  });
  const { tenantId, pool: db, topology } = harness;

  const component = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'VOID-MISSING-RAW',
    type: 'raw'
  });
  const outputItem = await harness.createItem({
    defaultLocationId: topology.defaults.QA.id,
    skuPrefix: 'VOID-MISSING-FG',
    type: 'finished'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: component.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 20,
    unitCost: 9
  });

  const bom = await harness.createBomAndActivate({
    outputItemId: outputItem.id,
    components: [{ componentItemId: component.id, quantityPer: 1 }],
    suffix: randomUUID().slice(0, 6)
  });
  const workOrder = await harness.createWorkOrder({
    kind: 'production',
    outputItemId: outputItem.id,
    outputUom: 'each',
    quantityPlanned: 10,
    bomId: bom.id,
    defaultConsumeLocationId: topology.defaults.SELLABLE.id,
    defaultProduceLocationId: topology.defaults.QA.id
  });

  const report = await harness.reportProduction(
    workOrder.id,
    {
      warehouseId: topology.warehouse.id,
      outputQty: 10,
      outputUom: 'each',
      occurredAt: '2026-02-22T00:00:00.000Z',
      idempotencyKey: `wo-void-missing-report:${randomUUID()}`
    },
    {}
  );
  await db.query(
    `DELETE FROM inventory_reservations
      WHERE tenant_id = $1
        AND demand_type = 'work_order_component'
        AND demand_id = $2`,
    [tenantId, workOrder.id]
  );

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((value) => String(value)).join(' '));
  };
  try {
    const result = await harness.voidProductionReport(
      workOrder.id,
      {
        workOrderExecutionId: report.productionReportId,
        reason: 'missing reservation correction',
        idempotencyKey: `wo-void-missing:${randomUUID()}`
      },
      { type: 'system', id: null }
    );
    assert.ok(result.outputReversalMovementId);
    assert.ok(result.componentReturnMovementId);
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(
    warnings.some((entry) => entry.includes('WO_VOID_RESERVATION_RESTORE_WARNING')),
    `expected reservation restore drift warning, got ${warnings.join('\n')}`
  );
});
