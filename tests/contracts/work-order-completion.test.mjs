import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { assertMovementContract } from './helpers/mutationContract.mjs';

test('work order completion contract writes ledger, emits events, updates projections, and replays cleanly', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'contract-wo-complete', tenantName: 'Contract WO Completion' });
  const { topology } = harness;
  const component = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'WO-COMPLETE-COMP',
    type: 'raw'
  });
  const output = await harness.createItem({
    defaultLocationId: topology.defaults.QA.id,
    skuPrefix: 'WO-COMPLETE-OUT',
    type: 'finished'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: component.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 4,
    unitCost: 2
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
    quantityPlanned: 2,
    bomId: bom.id,
    defaultConsumeLocationId: topology.defaults.SELLABLE.id,
    defaultProduceLocationId: topology.defaults.QA.id
  });
  const report = await harness.reportProduction(
    workOrder.id,
    {
      warehouseId: topology.warehouse.id,
      outputQty: 2,
      outputUom: 'each',
      occurredAt: '2026-03-02T00:00:00.000Z',
      idempotencyKey: 'contract-wo-completion'
    },
    {},
    { idempotencyKey: 'contract-wo-completion' }
  );

  await assertMovementContract({
    harness,
    movementId: report.componentIssueMovementId,
    expectedMovementType: 'issue',
    expectedSourceType: 'work_order_batch_post_issue',
    expectedLineCount: 1,
    expectedBalances: [{ itemId: component.id, locationId: topology.defaults.SELLABLE.id, onHand: 2 }]
  });
  await assertMovementContract({
    harness,
    movementId: report.productionReceiptMovementId,
    expectedMovementType: 'receive',
    expectedSourceType: 'work_order_batch_post_completion',
    expectedLineCount: 1,
    expectedBalances: [{ itemId: output.id, locationId: topology.defaults.QA.id, onHand: 2 }]
  });
});
