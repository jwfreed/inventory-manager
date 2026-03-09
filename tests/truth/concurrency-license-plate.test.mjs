import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';

test('simultaneous license plate moves do not duplicate the move or corrupt stock', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-concurrent-lpn',
    tenantName: 'Truth Concurrent LPN'
  });
  const { topology, pool: db, tenantId } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'TRUTH-LPN',
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
    lpn: `TRUTH-LPN-${randomUUID().slice(0, 8)}`,
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
        notes: 'Truth LPN move A',
        idempotencyKey: `truth-lpn-a-${randomUUID()}`
      });
    },
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.moveLicensePlate({
        licensePlateId: licensePlate.id,
        fromLocationId: topology.defaults.SELLABLE.id,
        toLocationId: topology.defaults.HOLD.id,
        notes: 'Truth LPN move B',
        idempotencyKey: `truth-lpn-b-${randomUUID()}`
      });
    }
  ]);

  const fulfilled = outcomes.filter((entry) => entry.status === 'fulfilled');
  const rejected = outcomes.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);

  const plateResult = await db.query(
    `SELECT location_id
       FROM license_plates
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, licensePlate.id]
  );
  assert.ok([topology.defaults.QA.id, topology.defaults.HOLD.id].includes(plateResult.rows[0]?.location_id));
  assert.equal(await harness.readOnHand(item.id, topology.defaults.SELLABLE.id), 0);
  assert.equal(
    (await harness.readOnHand(item.id, topology.defaults.QA.id))
      + (await harness.readOnHand(item.id, topology.defaults.HOLD.id)),
    5
  );
  await harness.runStrictInvariants();
});
