import test from 'node:test';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { assertMovementContract } from './helpers/mutationContract.mjs';

test('transfer contract writes ledger, emits events, updates projections, and replays cleanly', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'contract-transfer', tenantName: 'Contract Transfer' });
  const { topology } = harness;
  const store = await harness.createWarehouseWithSellable('CONTRACT-STORE');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'TRANSFER',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });
  const transfer = await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId: item.id,
    quantity: 4,
    uom: 'each',
    reasonCode: 'contract_transfer',
    notes: 'contract transfer',
    idempotencyKey: 'contract-transfer'
  });

  await assertMovementContract({
    harness,
    movementId: transfer.movementId,
    expectedMovementType: 'transfer',
    expectedSourceType: 'inventory_transfer',
    expectedLineCount: 2,
    expectedBalances: [
      { itemId: item.id, locationId: topology.defaults.SELLABLE.id, onHand: 6 },
      { itemId: item.id, locationId: store.sellable.id, onHand: 4 }
    ]
  });
});
