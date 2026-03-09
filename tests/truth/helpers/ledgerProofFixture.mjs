import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../../helpers/service-harness.mjs';

export async function createLedgerProofFixture(prefix) {
  const harness = await createServiceHarness({
    tenantPrefix: prefix,
    tenantName: `Truth ${prefix}`
  });
  const store = await harness.createWarehouseWithSellable(`STORE-${randomUUID().slice(0, 6)}`);
  const item = await harness.createItem({
    defaultLocationId: harness.topology.defaults.SELLABLE.id,
    skuPrefix: 'TRUTH',
    type: 'raw'
  });

  await harness.seedStockViaCount({
    warehouseId: harness.topology.warehouse.id,
    itemId: item.id,
    locationId: harness.topology.defaults.SELLABLE.id,
    quantity: 12,
    unitCost: 4.5
  });

  await harness.postTransfer({
    sourceLocationId: harness.topology.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId: item.id,
    quantity: 5,
    uom: 'each',
    reasonCode: 'truth_distribution',
    notes: 'Truth suite transfer',
    idempotencyKey: `truth-transfer:${harness.tenantId}:${item.id}`
  });

  return {
    harness,
    itemId: item.id,
    sourceLocationId: harness.topology.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id
  };
}
