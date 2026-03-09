import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { assertMovementContract } from './helpers/mutationContract.mjs';

test('work order reversal contract writes compensating ledger rows, emits events, restores projections, and replays cleanly', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'contract-wo-reversal', tenantName: 'Contract WO Reversal' });
  const { topology, pool: db, tenantId } = harness;
  const component = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'WO-REV-COMP',
    type: 'raw'
  });
  const output = await harness.createItem({
    defaultLocationId: topology.defaults.QA.id,
    skuPrefix: 'WO-REV-OUT',
    type: 'finished'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: component.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 6,
    unitCost: 3
  });
  const bom = await harness.createBomAndActivate({
    outputItemId: output.id,
    components: [{ componentItemId: component.id, quantityPer: 1 }],
    suffix: randomUUID().slice(0, 6)
  });
  const workOrder = await harness.createWorkOrder({
    kind: 'production',
    outputItemId: output.id,
    outputUom: 'each',
    quantityPlanned: 3,
    bomId: bom.id,
    defaultConsumeLocationId: topology.defaults.SELLABLE.id,
    defaultProduceLocationId: topology.defaults.QA.id
  });

  const beforeComponent = await harness.readOnHand(component.id, topology.defaults.SELLABLE.id);
  const beforeOutput = await harness.readOnHand(output.id, topology.defaults.QA.id);

  const report = await harness.reportProduction(
    workOrder.id,
    {
      warehouseId: topology.warehouse.id,
      outputQty: 3,
      outputUom: 'each',
      occurredAt: '2026-03-03T00:00:00.000Z',
      idempotencyKey: 'contract-wo-reversal-report'
    },
    {},
    { idempotencyKey: 'contract-wo-reversal-report' }
  );

  const reversal = await harness.voidProductionReport(
    workOrder.id,
    {
      workOrderExecutionId: report.productionReportId,
      reason: 'contract reversal',
      idempotencyKey: 'contract-wo-reversal-void'
    },
    { type: 'system', id: null },
    { idempotencyKey: 'contract-wo-reversal-void' }
  );

  await assertMovementContract({
    harness,
    movementId: reversal.componentReturnMovementId,
    expectedMovementType: 'receive',
    expectedSourceType: 'work_order_batch_void_components',
    expectedLineCount: 1
  });
  await assertMovementContract({
    harness,
    movementId: reversal.outputReversalMovementId,
    expectedMovementType: 'issue',
    expectedSourceType: 'work_order_batch_void_output',
    expectedLineCount: 1
  });

  assert.equal(await harness.readOnHand(component.id, topology.defaults.SELLABLE.id), beforeComponent);
  assert.equal(await harness.readOnHand(output.id, topology.defaults.QA.id), beforeOutput);

  const reversalCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_id = $2
        AND source_type IN ('work_order_batch_void_components', 'work_order_batch_void_output')`,
    [tenantId, report.productionReportId]
  );
  assert.equal(Number(reversalCount.rows[0]?.count ?? 0), 2);
});
