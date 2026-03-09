import test from 'node:test';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { assertMovementContract } from './helpers/mutationContract.mjs';

test('adjustment contract writes ledger, emits events, updates projections, and replays cleanly', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'contract-adjustment', tenantName: 'Contract Adjustment' });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'ADJUST',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 3
  });
  const draft = await harness.createInventoryAdjustmentDraft(
    {
      occurredAt: '2026-03-01T00:00:00.000Z',
      notes: 'contract adjustment',
      lines: [
        {
          lineNumber: 1,
          itemId: item.id,
          locationId: topology.defaults.SELLABLE.id,
          uom: 'each',
          quantityDelta: -2,
          reasonCode: 'contract_adjustment'
        }
      ]
    },
    { type: 'system', id: null },
    { idempotencyKey: 'contract-adjustment-draft' }
  );
  const posted = await harness.postInventoryAdjustmentDraft(draft.id, {
    actor: { type: 'system', id: null }
  });

  await assertMovementContract({
    harness,
    movementId: posted.inventoryMovementId,
    expectedMovementType: 'adjustment',
    expectedSourceType: 'inventory_adjustment_post',
    expectedLineCount: 1,
    expectedBalances: [{ itemId: item.id, locationId: topology.defaults.SELLABLE.id, onHand: 3 }]
  });
});
