import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { assertMovementContract, findMovementBySourceId } from './helpers/mutationContract.mjs';

test('work order issue contract writes ledger, emits events, updates projections, and replays cleanly', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'contract-wo-issue', tenantName: 'Contract WO Issue' });
  const { topology, pool: db, tenantId } = harness;
  const component = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'WO-COMP',
    type: 'raw'
  });
  const output = await harness.createItem({
    defaultLocationId: topology.defaults.QA.id,
    skuPrefix: 'WO-OUT',
    type: 'finished'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: component.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
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
    quantityPlanned: 2,
    bomId: bom.id,
    defaultConsumeLocationId: topology.defaults.SELLABLE.id,
    defaultProduceLocationId: topology.defaults.QA.id
  });
  const issue = await harness.createWorkOrderIssueDraft(workOrder.id, {
    occurredAt: '2026-03-01T00:00:00.000Z',
    notes: 'contract wo issue',
    lines: [
      {
        lineNumber: 1,
        componentItemId: component.id,
        fromLocationId: topology.defaults.SELLABLE.id,
        uom: 'each',
        quantityIssued: 2,
        reasonCode: 'contract_issue'
      }
    ]
  }, { idempotencyKey: 'contract-wo-issue-draft' });
  await harness.postWorkOrderIssueDraft(workOrder.id, issue.id, { actor: { type: 'system', id: null } });

  const movement = await findMovementBySourceId(db, tenantId, 'work_order_issue_post', issue.id);
  await assertMovementContract({
    harness,
    movementId: movement.id,
    expectedMovementType: 'issue',
    expectedSourceType: 'work_order_issue_post',
    expectedLineCount: 1,
    expectedBalances: [{ itemId: component.id, locationId: topology.defaults.SELLABLE.id, onHand: 3 }]
  });
});
