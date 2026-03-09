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
