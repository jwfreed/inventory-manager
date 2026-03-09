import test from 'node:test';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { assertMovementContract, findMovementBySourceType } from './helpers/mutationContract.mjs';

test('count contract writes ledger, emits events, updates projections, and replays cleanly', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'contract-count', tenantName: 'Contract Count' });
  const { topology, pool: db, tenantId } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'COUNT',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 7,
    unitCost: 2
  });

  const movement = await findMovementBySourceType(db, tenantId, 'cycle_count_post');
  await assertMovementContract({
    harness,
    movementId: movement.id,
    expectedMovementType: 'adjustment',
    expectedSourceType: 'cycle_count_post',
    expectedLineCount: 1,
    expectedBalances: [{ itemId: item.id, locationId: topology.defaults.SELLABLE.id, onHand: 7 }]
  });
});
