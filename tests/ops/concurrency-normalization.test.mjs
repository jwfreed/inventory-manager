import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from './helpers/service-harness.mjs';

async function createProductionFixture(label) {
  const harness = await createServiceHarness({
    tenantPrefix: label,
    tenantName: `Concurrency ${label}`
  });
  const { topology } = harness;
  const component = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: `${label}-COMP`,
    type: 'raw'
  });
  const output = await harness.createItem({
    defaultLocationId: topology.defaults.QA.id,
    skuPrefix: `${label}-FG`,
    type: 'finished'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: component.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 4
  });
  const bom = await harness.createBomAndActivate({
    outputItemId: output.id,
    components: [
      {
        componentItemId: component.id,
        quantityPer: 1
      }
    ],
    suffix: label
  });
  const workOrder = await harness.createWorkOrder({
    kind: 'production',
    outputItemId: output.id,
    outputUom: 'each',
    quantityPlanned: 10,
    bomId: bom.id,
    defaultConsumeLocationId: topology.defaults.SELLABLE.id,
    defaultProduceLocationId: topology.defaults.QA.id
  });
  return {
    harness,
    topology,
    componentItemId: component.id,
    outputItemId: output.id,
    workOrderId: workOrder.id
  };
}

test('simultaneous transfers on the same source location stay serialized and preserve invariants', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'concurrent-transfer',
    tenantName: 'Concurrent Transfer Tenant'
  });
  const { topology } = harness;
  const storeA = await harness.createWarehouseWithSellable('STORE-A');
  const storeB = await harness.createWarehouseWithSellable('STORE-B');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'CT-ITEM',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  const outcomes = await harness.runConcurrently([
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: storeA.sellable.id,
        itemId: item.id,
        quantity: 6,
        uom: 'each',
        reasonCode: 'concurrency_a',
        notes: 'Concurrent transfer A',
        idempotencyKey: `concurrent-transfer-a-${randomUUID()}`
      });
    },
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: storeB.sellable.id,
        itemId: item.id,
        quantity: 6,
        uom: 'each',
        reasonCode: 'concurrency_b',
        notes: 'Concurrent transfer B',
        idempotencyKey: `concurrent-transfer-b-${randomUUID()}`
      });
    }
  ]);

  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(await harness.readOnHand(item.id, topology.defaults.SELLABLE.id), 4);
  assert.equal(
    (await harness.readOnHand(item.id, storeA.sellable.id))
    + (await harness.readOnHand(item.id, storeB.sellable.id)),
    6
  );
  await harness.runStrictInvariants();
});

test('simultaneous license plate moves do not duplicate the move or corrupt stock', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'concurrent-lpn',
    tenantName: 'Concurrent LPN Tenant'
  });
  const { topology, pool: db, tenantId } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'CLPN-ITEM',
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
    lpn: `LPN-${randomUUID().slice(0, 8)}`,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    uom: 'each'
  });

  const outcomes = await harness.runConcurrently([
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.moveLicensePlate({
        licensePlateId: licensePlate.id,
        fromLocationId: topology.defaults.SELLABLE.id,
        toLocationId: topology.defaults.QA.id,
        notes: 'Concurrent LPN move A',
        idempotencyKey: `concurrent-lpn-a-${randomUUID()}`
      });
    },
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.moveLicensePlate({
        licensePlateId: licensePlate.id,
        fromLocationId: topology.defaults.SELLABLE.id,
        toLocationId: topology.defaults.HOLD.id,
        notes: 'Concurrent LPN move B',
        idempotencyKey: `concurrent-lpn-b-${randomUUID()}`
      });
    }
  ]);

  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);

  const plateResult = await db.query(
    `SELECT location_id
       FROM license_plates
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, licensePlate.id]
  );
  assert.ok(
    [topology.defaults.QA.id, topology.defaults.HOLD.id].includes(plateResult.rows[0]?.location_id)
  );
  await harness.runStrictInvariants();
});

test('concurrent manufacturing reports preserve work-order valuation and replay safety', async () => {
  const { harness, topology, outputItemId, workOrderId } = await createProductionFixture('concurrent-report');
  const outcomes = await harness.runConcurrently([
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.reportProduction(
        workOrderId,
        {
          warehouseId: topology.warehouse.id,
          outputQty: 5,
          outputUom: 'each',
          occurredAt: '2026-03-03T00:00:00.000Z'
        },
        {},
        { idempotencyKey: `concurrent-report-a-${randomUUID()}` }
      );
    },
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.reportProduction(
        workOrderId,
        {
          warehouseId: topology.warehouse.id,
          outputQty: 5,
          outputUom: 'each',
          occurredAt: '2026-03-03T00:00:01.000Z'
        },
        {},
        { idempotencyKey: `concurrent-report-b-${randomUUID()}` }
      );
    }
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 2);
  assert.equal(await harness.readOnHand(outputItemId, topology.defaults.QA.id), 10);
  await harness.runStrictInvariants();
});

test('duplicate idempotency retries converge on one authoritative transfer movement', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'concurrent-idem',
    tenantName: 'Concurrent Idempotency Tenant'
  });
  const { topology } = harness;
  const store = await harness.createWarehouseWithSellable('IDEM-STORE');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'CID-ITEM',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 8,
    unitCost: 4
  });

  const idempotencyKey = `concurrent-idem-${randomUUID()}`;
  const outcomes = await harness.runConcurrently([
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: store.sellable.id,
        itemId: item.id,
        quantity: 3,
        uom: 'each',
        reasonCode: 'idempotency',
        notes: 'Concurrent idempotency retry',
        idempotencyKey
      });
    },
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.postTransfer({
        sourceLocationId: topology.defaults.SELLABLE.id,
        destinationLocationId: store.sellable.id,
        itemId: item.id,
        quantity: 3,
        uom: 'each',
        reasonCode: 'idempotency',
        notes: 'Concurrent idempotency retry',
        idempotencyKey
      });
    }
  ]);

  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled').map((outcome) => outcome.value);
  assert.equal(fulfilled.length, 2);
  assert.equal(new Set(fulfilled.map((result) => result.movementId)).size, 1);
  assert.equal(await harness.countInventoryMovementsBySourceType('inventory_transfer'), 1);
  assert.equal(await harness.countIdempotencyRows(idempotencyKey), 1);
  await harness.runStrictInvariants();
});
