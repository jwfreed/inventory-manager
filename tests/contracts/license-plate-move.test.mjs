import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { assertMovementContract, findMovementByIdempotencyKey } from './helpers/mutationContract.mjs';

test('license plate move contract writes ledger, emits events, updates projections, and replays cleanly', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'contract-lpn', tenantName: 'Contract LPN Move' });
  const { topology, pool: db, tenantId } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'LPN',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 2
  });
  const licensePlate = await harness.createLicensePlate({
    lpn: `CONTRACT-LPN-${randomUUID().slice(0, 8)}`,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    uom: 'each'
  });
  const idempotencyKey = `contract-lpn-${randomUUID()}`;
  await harness.moveLicensePlate({
    licensePlateId: licensePlate.id,
    fromLocationId: topology.defaults.SELLABLE.id,
    toLocationId: topology.defaults.QA.id,
    notes: 'contract lpn move',
    idempotencyKey
  });

  const movement = await findMovementByIdempotencyKey(db, tenantId, idempotencyKey);
  await assertMovementContract({
    harness,
    movementId: movement.id,
    expectedMovementType: 'transfer',
    expectedSourceType: 'lpn_move',
    expectedLineCount: 2,
    expectedBalances: [
      { itemId: item.id, locationId: topology.defaults.SELLABLE.id, onHand: 0 },
      { itemId: item.id, locationId: topology.defaults.QA.id, onHand: 5 }
    ]
  });
});
