import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServiceHarness } from '../helpers/service-harness.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  createReservations,
  allocateReservation,
  getReservation
} = require('../../src/services/orderToCash.service.ts');
const {
  createWave,
  createPickTask,
  getPickTask,
  confirmPickTask
} = require('../../src/services/picking.service.ts');
const {
  createShippingContainer,
  addShippingContainerItem,
  sealShippingContainer,
  shipContainer
} = require('../../src/services/shippingContainers.service.ts');

async function readBalance(harness, itemId, locationId, uom = 'each') {
  const result = await harness.pool.query(
    `SELECT COALESCE(on_hand, 0)::numeric AS on_hand,
            COALESCE(reserved, 0)::numeric AS reserved,
            COALESCE(allocated, 0)::numeric AS allocated
       FROM inventory_balance
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = $4`,
    [harness.tenantId, itemId, locationId, uom]
  );
  return {
    onHand: Number(result.rows[0]?.on_hand ?? 0),
    reserved: Number(result.rows[0]?.reserved ?? 0),
    allocated: Number(result.rows[0]?.allocated ?? 0)
  };
}

// ─── Allocation eligibility ──────────────────────────────────────────────────

test('allocation eligibility: reservation only allowed against SELLABLE location', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-alloc-eligibility',
    tenantName: 'WP6 Alloc Eligibility'
  });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'ALLOC-ELIG',
    type: 'raw'
  });
  const order = await harness.createSalesOrder({
    soNumber: `SO-AE-${randomUUID().slice(0, 8)}`,
    customerId: (await harness.createCustomer('AE')).id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 5 }]
  });

  // Reservation against HOLD location (non-sellable) must fail
  await assert.rejects(
    () =>
      createReservations(
        harness.tenantId,
        {
          reservations: [
            {
              demandType: 'sales_order_line',
              demandId: order.lines[0].id,
              itemId: item.id,
              locationId: topology.defaults.HOLD.id,
              warehouseId: topology.warehouse.id,
              uom: 'each',
              quantityReserved: 5
            }
          ]
        },
        { idempotencyKey: `alloc-elig:hold:${randomUUID()}` }
      ),
    (err) => {
      assert.ok(
        err.message === 'NON_SELLABLE_LOCATION' || err.message.includes('NON_SELLABLE'),
        `Expected NON_SELLABLE_LOCATION, got: ${err.message}`
      );
      return true;
    }
  );

  // Reservation against QA location (non-sellable) must fail
  await assert.rejects(
    () =>
      createReservations(
        harness.tenantId,
        {
          reservations: [
            {
              demandType: 'sales_order_line',
              demandId: order.lines[0].id,
              itemId: item.id,
              locationId: topology.defaults.QA.id,
              warehouseId: topology.warehouse.id,
              uom: 'each',
              quantityReserved: 5
            }
          ]
        },
        { idempotencyKey: `alloc-elig:qa:${randomUUID()}` }
      ),
    (err) => {
      assert.ok(
        err.message === 'NON_SELLABLE_LOCATION' || err.message.includes('NON_SELLABLE'),
        `Expected NON_SELLABLE_LOCATION, got: ${err.message}`
      );
      return true;
    }
  );
});

// ─── Partial allocation ───────────────────────────────────────────────────────

test('partial allocation: allowBackorder=false fails when stock insufficient', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-partial-alloc',
    tenantName: 'WP6 Partial Alloc'
  });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'PARTIAL-ALLOC',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 10
  });
  const order = await harness.createSalesOrder({
    soNumber: `SO-PA-${randomUUID().slice(0, 8)}`,
    customerId: (await harness.createCustomer('PA')).id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 10 }]
  });

  await assert.rejects(
    () =>
      createReservations(
        harness.tenantId,
        {
          reservations: [
            {
              demandType: 'sales_order_line',
              demandId: order.lines[0].id,
              itemId: item.id,
              locationId: topology.defaults.SELLABLE.id,
              warehouseId: topology.warehouse.id,
              uom: 'each',
              quantityReserved: 10,
              allowBackorder: false
            }
          ]
        },
        { idempotencyKey: `partial-alloc:${randomUUID()}` }
      ),
    (err) => {
      assert.ok(
        err.code === 'ATP_INSUFFICIENT_AVAILABLE' || err.message === 'ATP_INSUFFICIENT_AVAILABLE',
        `Expected ATP_INSUFFICIENT_AVAILABLE, got: ${err.message}`
      );
      return true;
    }
  );
});

test('partial allocation: allowBackorder=true reserves only available quantity', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-backorder-alloc',
    tenantName: 'WP6 Backorder Alloc'
  });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'BO-ALLOC',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 6,
    unitCost: 8
  });
  const order = await harness.createSalesOrder({
    soNumber: `SO-BO-${randomUUID().slice(0, 8)}`,
    customerId: (await harness.createCustomer('BO')).id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 10 }]
  });

  const reservations = await createReservations(
    harness.tenantId,
    {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: order.lines[0].id,
          itemId: item.id,
          locationId: topology.defaults.SELLABLE.id,
          warehouseId: topology.warehouse.id,
          uom: 'each',
          quantityReserved: 10,
          allowBackorder: true
        }
      ]
    },
    { idempotencyKey: `bo-alloc:${randomUUID()}` }
  );

  // Only 6 units available; reservation capped at 6
  assert.equal(reservations.length, 1);
  assert.equal(Number(reservations[0].quantityReserved), 6);

  const balance = await readBalance(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(balance.reserved, 6);
});

// ─── Double allocation prevention ────────────────────────────────────────────

test('double allocation prevention: two reservations cannot exceed available stock', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-double-alloc',
    tenantName: 'WP6 Double Alloc'
  });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'DBL-ALLOC',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 10
  });
  const order1 = await harness.createSalesOrder({
    soNumber: `SO-DA1-${randomUUID().slice(0, 8)}`,
    customerId: (await harness.createCustomer('DA1')).id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 5 }]
  });
  const order2 = await harness.createSalesOrder({
    soNumber: `SO-DA2-${randomUUID().slice(0, 8)}`,
    customerId: (await harness.createCustomer('DA2')).id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 5 }]
  });

  // First reservation consumes all 5 available
  const res1 = await createReservations(
    harness.tenantId,
    {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: order1.lines[0].id,
          itemId: item.id,
          locationId: topology.defaults.SELLABLE.id,
          warehouseId: topology.warehouse.id,
          uom: 'each',
          quantityReserved: 5,
          allowBackorder: false
        }
      ]
    },
    { idempotencyKey: `da-res1:${randomUUID()}` }
  );
  assert.equal(res1.length, 1);
  assert.equal(Number(res1[0].quantityReserved), 5);

  // Second reservation with allowBackorder=false must fail (0 available)
  await assert.rejects(
    () =>
      createReservations(
        harness.tenantId,
        {
          reservations: [
            {
              demandType: 'sales_order_line',
              demandId: order2.lines[0].id,
              itemId: item.id,
              locationId: topology.defaults.SELLABLE.id,
              warehouseId: topology.warehouse.id,
              uom: 'each',
              quantityReserved: 5,
              allowBackorder: false
            }
          ]
        },
        { idempotencyKey: `da-res2:${randomUUID()}` }
      ),
    (err) => {
      assert.ok(
        err.code === 'ATP_INSUFFICIENT_AVAILABLE' || err.message === 'ATP_INSUFFICIENT_AVAILABLE',
        `Expected ATP_INSUFFICIENT_AVAILABLE, got: ${err.message}`
      );
      return true;
    }
  );

  // Balance: 5 reserved, 0 allocated, 5 on_hand
  const balance = await readBalance(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(balance.reserved, 5);
  assert.equal(balance.allocated, 0);
  assert.equal(balance.onHand, 5);
});

// ─── Pick requires ALLOCATED reservation ─────────────────────────────────────

test('pick confirmation requires reservation to be ALLOCATED, not RESERVED', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-pick-requires-alloc',
    tenantName: 'WP6 Pick Requires Alloc'
  });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'PICK-ALLOC',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 10
  });
  const order = await harness.createSalesOrder({
    soNumber: `SO-PALL-${randomUUID().slice(0, 8)}`,
    customerId: (await harness.createCustomer('PALL')).id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 3 }]
  });

  const reservations = await createReservations(
    harness.tenantId,
    {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: order.lines[0].id,
          itemId: item.id,
          locationId: topology.defaults.SELLABLE.id,
          warehouseId: topology.warehouse.id,
          uom: 'each',
          quantityReserved: 3
        }
      ]
    },
    { idempotencyKey: `pick-alloc:${randomUUID()}` }
  );
  assert.equal(reservations[0].status, 'RESERVED');

  // Create a pick task manually linked to the RESERVED reservation
  const task = await createPickTask(harness.tenantId, {
    pickBatchId: (await harness.pool.query(
      `INSERT INTO pick_batches (id, tenant_id, status, pick_type, notes, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'draft', 'single_order', NULL, now(), now()) RETURNING id`,
      [harness.tenantId]
    )).rows[0].id,
    inventoryReservationId: reservations[0].id,
    salesOrderLineId: order.lines[0].id,
    itemId: item.id,
    uom: 'each',
    fromLocationId: topology.defaults.SELLABLE.id,
    quantityRequested: 3
  });

  // Confirm pick while reservation is still RESERVED → must fail
  await assert.rejects(
    () => confirmPickTask(harness.tenantId, task.id, { quantityPicked: 3 }),
    (err) => {
      assert.equal(
        err.message,
        'PICK_TASK_RESERVATION_NOT_ALLOCATED',
        `Expected PICK_TASK_RESERVATION_NOT_ALLOCATED, got: ${err.message}`
      );
      return true;
    }
  );

  // Allocate the reservation, then confirm pick → must succeed
  await allocateReservation(harness.tenantId, reservations[0].id, topology.warehouse.id, {
    idempotencyKey: `pick-alloc-transition:${randomUUID()}`
  });

  const confirmed = await confirmPickTask(harness.tenantId, task.id, { quantityPicked: 3 });
  assert.equal(confirmed.status, 'picked');
  assert.equal(confirmed.quantityPicked, 3);
  assert.ok(confirmed.pickedAt != null);
});

// ─── Double pick prevention ───────────────────────────────────────────────────

test('double pick prevention: second confirmation of same task is rejected', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-double-pick',
    tenantName: 'WP6 Double Pick'
  });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'DBL-PICK',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 10
  });
  const order = await harness.createSalesOrder({
    soNumber: `SO-DP-${randomUUID().slice(0, 8)}`,
    customerId: (await harness.createCustomer('DP')).id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 4 }]
  });

  const reservations = await createReservations(
    harness.tenantId,
    {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: order.lines[0].id,
          itemId: item.id,
          locationId: topology.defaults.SELLABLE.id,
          warehouseId: topology.warehouse.id,
          uom: 'each',
          quantityReserved: 4
        }
      ]
    },
    { idempotencyKey: `dp-res:${randomUUID()}` }
  );

  await allocateReservation(harness.tenantId, reservations[0].id, topology.warehouse.id, {
    idempotencyKey: `dp-alloc:${randomUUID()}`
  });

  const { tasks } = await createWave(harness.tenantId, [order.id]);
  const task = tasks[0];

  // First pick confirmation succeeds
  await confirmPickTask(harness.tenantId, task.id, { quantityPicked: 4 });

  // Second confirmation must fail
  await assert.rejects(
    () => confirmPickTask(harness.tenantId, task.id, { quantityPicked: 4 }),
    (err) => {
      assert.equal(err.message, 'PICK_TASK_INVALID_STATE');
      return true;
    }
  );
});

// ─── Partial pick ─────────────────────────────────────────────────────────────

test('partial pick: quantityPicked less than quantityRequested is accepted', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-partial-pick',
    tenantName: 'WP6 Partial Pick'
  });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'PART-PICK',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 10
  });
  const order = await harness.createSalesOrder({
    soNumber: `SO-PP-${randomUUID().slice(0, 8)}`,
    customerId: (await harness.createCustomer('PP')).id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 5 }]
  });

  const reservations = await createReservations(
    harness.tenantId,
    {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: order.lines[0].id,
          itemId: item.id,
          locationId: topology.defaults.SELLABLE.id,
          warehouseId: topology.warehouse.id,
          uom: 'each',
          quantityReserved: 5
        }
      ]
    },
    { idempotencyKey: `pp-res:${randomUUID()}` }
  );

  await allocateReservation(harness.tenantId, reservations[0].id, topology.warehouse.id, {
    idempotencyKey: `pp-alloc:${randomUUID()}`
  });

  const { tasks } = await createWave(harness.tenantId, [order.id]);
  const task = tasks[0];

  // Pick 3 of 5 requested
  const confirmed = await confirmPickTask(harness.tenantId, task.id, { quantityPicked: 3 });
  assert.equal(confirmed.status, 'picked');
  assert.equal(confirmed.quantityPicked, 3);
  assert.equal(confirmed.quantityRequested, 5);
});

// ─── Pack requires picked task ────────────────────────────────────────────────

test('pack: adding a pending (unpicked) task to a container is rejected', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-pack-requires-pick',
    tenantName: 'WP6 Pack Requires Pick'
  });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'PACK-PICK',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 10
  });
  const customer = await harness.createCustomer('PACK-PICK');
  const order = await harness.createSalesOrder({
    soNumber: `SO-PKPK-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 3 }]
  });

  const reservations = await createReservations(
    harness.tenantId,
    {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: order.lines[0].id,
          itemId: item.id,
          locationId: topology.defaults.SELLABLE.id,
          warehouseId: topology.warehouse.id,
          uom: 'each',
          quantityReserved: 3
        }
      ]
    },
    { idempotencyKey: `pkpk-res:${randomUUID()}` }
  );
  await allocateReservation(harness.tenantId, reservations[0].id, topology.warehouse.id, {
    idempotencyKey: `pkpk-alloc:${randomUUID()}`
  });

  const { tasks } = await createWave(harness.tenantId, [order.id]);
  const task = tasks[0];

  const shipment = await harness.createShipment({
    salesOrderId: order.id,
    shippedAt: new Date().toISOString(),
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ salesOrderLineId: order.lines[0].id, uom: 'each', quantityShipped: 3 }]
  });

  const container = await createShippingContainer(harness.tenantId, {
    salesOrderShipmentId: shipment.id,
    packageRef: 'BOX-001'
  });

  // Adding a pending (not yet picked) task must fail
  await assert.rejects(
    () =>
      addShippingContainerItem(harness.tenantId, container.id, {
        pickTaskId: task.id,
        salesOrderLineId: order.lines[0].id,
        itemId: item.id,
        uom: 'each',
        quantity: 3
      }),
    (err) => {
      assert.equal(err.message, 'PICK_TASK_NOT_PICKED');
      return true;
    }
  );

  // Confirm pick, then adding to container succeeds
  await confirmPickTask(harness.tenantId, task.id, { quantityPicked: 3 });
  const containerItem = await addShippingContainerItem(harness.tenantId, container.id, {
    pickTaskId: task.id,
    salesOrderLineId: order.lines[0].id,
    itemId: item.id,
    uom: 'each',
    quantity: 3
  });
  assert.equal(containerItem.quantity, 3);
  assert.equal(containerItem.pickTaskId, task.id);
});

test('seal: sealing a container twice is rejected', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-seal-twice',
    tenantName: 'WP6 Seal Twice'
  });
  const container = await createShippingContainer(harness.tenantId, {
    packageRef: 'BOX-SEAL'
  });

  await sealShippingContainer(harness.tenantId, container.id);

  await assert.rejects(
    () => sealShippingContainer(harness.tenantId, container.id),
    (err) => {
      assert.equal(err.message, 'SHIPPING_CONTAINER_NOT_OPEN');
      return true;
    }
  );
});

// ─── Conservation across full flow ───────────────────────────────────────────

test('conservation: seed → reserve → allocate → pick → pack → ship leaves on_hand correct', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-conservation',
    tenantName: 'WP6 Conservation'
  });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'CONSERVE',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });

  // Verify seed
  const balanceBefore = await readBalance(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(balanceBefore.onHand, 10);
  assert.equal(balanceBefore.reserved, 0);
  assert.equal(balanceBefore.allocated, 0);

  const customer = await harness.createCustomer('CONS');
  const order = await harness.createSalesOrder({
    soNumber: `SO-CONS-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 7 }]
  });

  // Reserve
  const reservations = await createReservations(
    harness.tenantId,
    {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: order.lines[0].id,
          itemId: item.id,
          locationId: topology.defaults.SELLABLE.id,
          warehouseId: topology.warehouse.id,
          uom: 'each',
          quantityReserved: 7
        }
      ]
    },
    { idempotencyKey: `cons-res:${randomUUID()}` }
  );

  const balanceAfterReserve = await readBalance(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(balanceAfterReserve.reserved, 7);
  assert.equal(balanceAfterReserve.allocated, 0);
  assert.equal(balanceAfterReserve.onHand, 10); // on_hand unchanged until ship

  // Allocate
  await allocateReservation(harness.tenantId, reservations[0].id, topology.warehouse.id, {
    idempotencyKey: `cons-alloc:${randomUUID()}`
  });

  const balanceAfterAlloc = await readBalance(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(balanceAfterAlloc.reserved, 0);
  assert.equal(balanceAfterAlloc.allocated, 7);
  assert.equal(balanceAfterAlloc.onHand, 10); // on_hand unchanged until ship

  // Pick
  const { tasks } = await createWave(harness.tenantId, [order.id]);
  assert.equal(tasks.length, 1);
  const pickedTask = await confirmPickTask(harness.tenantId, tasks[0].id, { quantityPicked: 7 });
  assert.equal(pickedTask.status, 'picked');
  assert.equal(pickedTask.quantityPicked, 7);

  // Balance unchanged during pick (pick is operational tracking, not ledger state)
  const balanceAfterPick = await readBalance(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(balanceAfterPick.allocated, 7);
  assert.equal(balanceAfterPick.onHand, 10);

  // Pack
  const shipment = await harness.createShipment({
    salesOrderId: order.id,
    shippedAt: new Date().toISOString(),
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ salesOrderLineId: order.lines[0].id, uom: 'each', quantityShipped: 7 }]
  });
  const container = await createShippingContainer(harness.tenantId, {
    salesOrderShipmentId: shipment.id,
    packageRef: 'BOX-CONS'
  });
  await addShippingContainerItem(harness.tenantId, container.id, {
    pickTaskId: pickedTask.id,
    salesOrderLineId: order.lines[0].id,
    itemId: item.id,
    uom: 'each',
    quantity: 7
  });
  const sealed = await sealShippingContainer(harness.tenantId, container.id);
  assert.equal(sealed.status, 'sealed');

  // Ship — writes ledger movement, removes stock
  const posted = await harness.postShipment(shipment.id, {
    idempotencyKey: `cons-ship:${randomUUID()}`,
    actor: { type: 'system', id: null }
  });
  assert.ok(posted.inventoryMovementId);

  // Post-ship: on_hand reduced by 7, allocated returned to 0
  const balanceAfterShip = await readBalance(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(balanceAfterShip.onHand, 3);
  assert.equal(balanceAfterShip.reserved, 0);
  assert.equal(balanceAfterShip.allocated, 0);

  // Fulfill reservation
  const reservation = await getReservation(harness.tenantId, reservations[0].id, topology.warehouse.id);
  assert.equal(reservation.status, 'FULFILLED');

  // Verify ledger movement
  const movementRes = await harness.pool.query(
    `SELECT movement_type, status
       FROM inventory_movements
      WHERE id = $1 AND tenant_id = $2`,
    [posted.inventoryMovementId, harness.tenantId]
  );
  assert.equal(movementRes.rows[0].movement_type, 'issue');
  assert.equal(movementRes.rows[0].status, 'posted');
});

// ─── A: Ship requires sealed container ────────────────────────────────────────

test('ship: shipContainer requires sealed status (open container is rejected)', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-ship-sealed',
    tenantName: 'WP6 Ship Sealed'
  });

  // Open container cannot be shipped
  const openContainer = await createShippingContainer(harness.tenantId, {
    packageRef: 'BOX-OPEN'
  });
  await assert.rejects(
    () => shipContainer(harness.tenantId, openContainer.id, { idempotencyKey: `ship-open:${randomUUID()}` }),
    (err) => {
      assert.equal(err.message, 'SHIPPING_CONTAINER_NOT_SEALED');
      return true;
    }
  );

  // Sealed container can be shipped (standalone, no linked shipment)
  await sealShippingContainer(harness.tenantId, openContainer.id);
  const shipped = await shipContainer(harness.tenantId, openContainer.id, {
    idempotencyKey: `ship-sealed:${randomUUID()}`
  });
  assert.equal(shipped.status, 'shipped');
  assert.ok(shipped.shippedAt != null);
});

// ─── B: Ship moves inventory out of system ────────────────────────────────────

test('ship: shipContainer triggers inventory exit (on_hand reduced via ledger movement)', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-ship-exit',
    tenantName: 'WP6 Ship Exit'
  });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'SHIP-EXIT',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 8,
    unitCost: 10
  });
  const customer = await harness.createCustomer('SEXIT');
  const order = await harness.createSalesOrder({
    soNumber: `SO-SE-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 5 }]
  });

  const reservations = await createReservations(
    harness.tenantId,
    {
      reservations: [{
        demandType: 'sales_order_line',
        demandId: order.lines[0].id,
        itemId: item.id,
        locationId: topology.defaults.SELLABLE.id,
        warehouseId: topology.warehouse.id,
        uom: 'each',
        quantityReserved: 5
      }]
    },
    { idempotencyKey: `se-res:${randomUUID()}` }
  );
  await allocateReservation(harness.tenantId, reservations[0].id, topology.warehouse.id, {
    idempotencyKey: `se-alloc:${randomUUID()}`
  });

  const { tasks } = await createWave(harness.tenantId, [order.id]);
  await confirmPickTask(harness.tenantId, tasks[0].id, { quantityPicked: 5 });

  const shipment = await harness.createShipment({
    salesOrderId: order.id,
    shippedAt: new Date().toISOString(),
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ salesOrderLineId: order.lines[0].id, uom: 'each', quantityShipped: 5 }]
  });
  const container = await createShippingContainer(harness.tenantId, {
    salesOrderShipmentId: shipment.id,
    packageRef: 'BOX-SE'
  });
  await addShippingContainerItem(harness.tenantId, container.id, {
    pickTaskId: tasks[0].id,
    salesOrderLineId: order.lines[0].id,
    itemId: item.id,
    uom: 'each',
    quantity: 5
  });
  await sealShippingContainer(harness.tenantId, container.id);

  const balanceBefore = await readBalance(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(balanceBefore.onHand, 8);
  assert.equal(balanceBefore.allocated, 5);

  // shipContainer posts inventory movement then marks container shipped
  const shipped = await shipContainer(harness.tenantId, container.id, {
    idempotencyKey: `se-ship:${randomUUID()}`,
    actor: { type: 'system', id: null }
  });
  assert.equal(shipped.status, 'shipped');
  assert.ok(shipped.shippedAt != null);

  // Inventory exited
  const balanceAfter = await readBalance(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(balanceAfter.onHand, 3);
  assert.equal(balanceAfter.allocated, 0);

  // Ledger movement recorded
  const shipmentRow = await harness.pool.query(
    `SELECT inventory_movement_id FROM sales_order_shipments WHERE id = $1 AND tenant_id = $2`,
    [shipment.id, harness.tenantId]
  );
  assert.ok(shipmentRow.rows[0].inventory_movement_id != null);

  const movement = await harness.pool.query(
    `SELECT movement_type FROM inventory_movements WHERE id = $1 AND tenant_id = $2`,
    [shipmentRow.rows[0].inventory_movement_id, harness.tenantId]
  );
  assert.equal(movement.rows[0].movement_type, 'issue');
});

// ─── C: Double ship rejected ──────────────────────────────────────────────────

test('ship: shipping a container twice is rejected', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-double-ship',
    tenantName: 'WP6 Double Ship'
  });

  const container = await createShippingContainer(harness.tenantId, {
    packageRef: 'BOX-DS'
  });
  await sealShippingContainer(harness.tenantId, container.id);
  await shipContainer(harness.tenantId, container.id, {
    idempotencyKey: `ds-ship1:${randomUUID()}`
  });

  await assert.rejects(
    () => shipContainer(harness.tenantId, container.id, {
      idempotencyKey: `ds-ship2:${randomUUID()}`
    }),
    (err) => {
      assert.equal(err.message, 'SHIPPING_CONTAINER_NOT_SEALED');
      return true;
    }
  );
});

// ─── D: Pack cannot exceed picked quantity ────────────────────────────────────

test('pack integrity: packed quantity cannot exceed picked quantity', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-pack-qty',
    tenantName: 'WP6 Pack Qty'
  });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'PACK-QTY',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });
  const customer = await harness.createCustomer('PQTY');
  const order = await harness.createSalesOrder({
    soNumber: `SO-PQTY-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 5 }]
  });

  const reservations = await createReservations(
    harness.tenantId,
    {
      reservations: [{
        demandType: 'sales_order_line',
        demandId: order.lines[0].id,
        itemId: item.id,
        locationId: topology.defaults.SELLABLE.id,
        warehouseId: topology.warehouse.id,
        uom: 'each',
        quantityReserved: 5
      }]
    },
    { idempotencyKey: `pqty-res:${randomUUID()}` }
  );
  await allocateReservation(harness.tenantId, reservations[0].id, topology.warehouse.id, {
    idempotencyKey: `pqty-alloc:${randomUUID()}`
  });

  const { tasks } = await createWave(harness.tenantId, [order.id]);
  // Pick only 3 of 5
  await confirmPickTask(harness.tenantId, tasks[0].id, { quantityPicked: 3 });

  const container = await createShippingContainer(harness.tenantId, { packageRef: 'BOX-PQTY' });

  // Trying to pack 4 when only 3 were picked must fail
  await assert.rejects(
    () => addShippingContainerItem(harness.tenantId, container.id, {
      pickTaskId: tasks[0].id,
      salesOrderLineId: order.lines[0].id,
      itemId: item.id,
      uom: 'each',
      quantity: 4
    }),
    (err) => {
      assert.equal(err.message, 'PACK_QUANTITY_EXCEEDS_PICKED');
      return true;
    }
  );

  // Packing exactly 3 (= picked) succeeds
  const containerItem = await addShippingContainerItem(harness.tenantId, container.id, {
    pickTaskId: tasks[0].id,
    salesOrderLineId: order.lines[0].id,
    itemId: item.id,
    uom: 'each',
    quantity: 3
  });
  assert.equal(containerItem.quantity, 3);
});

// ─── E: Same pick task cannot be packed beyond picked qty across containers ───

test('pack integrity: same pick task cannot be packed into multiple containers beyond picked qty', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-cross-container',
    tenantName: 'WP6 Cross Container'
  });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'CROSS-CTR',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });
  const customer = await harness.createCustomer('XCTR');
  const order = await harness.createSalesOrder({
    soNumber: `SO-XCTR-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 5 }]
  });

  const reservations = await createReservations(
    harness.tenantId,
    {
      reservations: [{
        demandType: 'sales_order_line',
        demandId: order.lines[0].id,
        itemId: item.id,
        locationId: topology.defaults.SELLABLE.id,
        warehouseId: topology.warehouse.id,
        uom: 'each',
        quantityReserved: 5
      }]
    },
    { idempotencyKey: `xctr-res:${randomUUID()}` }
  );
  await allocateReservation(harness.tenantId, reservations[0].id, topology.warehouse.id, {
    idempotencyKey: `xctr-alloc:${randomUUID()}`
  });

  const { tasks } = await createWave(harness.tenantId, [order.id]);
  // Pick 3 of 5
  await confirmPickTask(harness.tenantId, tasks[0].id, { quantityPicked: 3 });

  const container1 = await createShippingContainer(harness.tenantId, { packageRef: 'BOX-XCTR-1' });
  const container2 = await createShippingContainer(harness.tenantId, { packageRef: 'BOX-XCTR-2' });

  // Pack 2 into container 1 (2 ≤ 3 picked) → success
  await addShippingContainerItem(harness.tenantId, container1.id, {
    pickTaskId: tasks[0].id,
    salesOrderLineId: order.lines[0].id,
    itemId: item.id,
    uom: 'each',
    quantity: 2
  });

  // Pack 2 more into container 2 (cumulative: 2+2=4 > 3 picked) → must fail
  await assert.rejects(
    () => addShippingContainerItem(harness.tenantId, container2.id, {
      pickTaskId: tasks[0].id,
      salesOrderLineId: order.lines[0].id,
      itemId: item.id,
      uom: 'each',
      quantity: 2
    }),
    (err) => {
      assert.equal(err.message, 'PACK_QUANTITY_EXCEEDS_PICKED');
      return true;
    }
  );

  // Pack 1 more into container 2 (cumulative: 2+1=3 = picked) → success
  const item2 = await addShippingContainerItem(harness.tenantId, container2.id, {
    pickTaskId: tasks[0].id,
    salesOrderLineId: order.lines[0].id,
    itemId: item.id,
    uom: 'each',
    quantity: 1
  });
  assert.equal(item2.quantity, 1);
});

// ─── F: Full lifecycle conservation via shipContainer ─────────────────────────

test('conservation: full outbound lifecycle (reserve→allocate→pick→pack→shipContainer) holds invariants', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-full-lifecycle',
    tenantName: 'WP6 Full Lifecycle'
  });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'FULLLIFE',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 8
  });

  const balanceSeed = await readBalance(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(balanceSeed.onHand, 10);
  assert.equal(balanceSeed.reserved, 0);
  assert.equal(balanceSeed.allocated, 0);

  const customer = await harness.createCustomer('FL');
  const order = await harness.createSalesOrder({
    soNumber: `SO-FL-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 6 }]
  });

  // Reserve
  const reservations = await createReservations(
    harness.tenantId,
    {
      reservations: [{
        demandType: 'sales_order_line',
        demandId: order.lines[0].id,
        itemId: item.id,
        locationId: topology.defaults.SELLABLE.id,
        warehouseId: topology.warehouse.id,
        uom: 'each',
        quantityReserved: 6
      }]
    },
    { idempotencyKey: `fl-res:${randomUUID()}` }
  );
  const b1 = await readBalance(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(b1.onHand, 10);
  assert.equal(b1.reserved, 6);
  assert.equal(b1.allocated, 0);

  // Allocate
  await allocateReservation(harness.tenantId, reservations[0].id, topology.warehouse.id, {
    idempotencyKey: `fl-alloc:${randomUUID()}`
  });
  const b2 = await readBalance(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(b2.onHand, 10);
  assert.equal(b2.reserved, 0);
  assert.equal(b2.allocated, 6);

  // Pick
  const { tasks } = await createWave(harness.tenantId, [order.id]);
  await confirmPickTask(harness.tenantId, tasks[0].id, { quantityPicked: 6 });
  const b3 = await readBalance(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(b3.onHand, 10); // unchanged until inventory exit
  assert.equal(b3.allocated, 6);

  // Pack + Seal
  const shipment = await harness.createShipment({
    salesOrderId: order.id,
    shippedAt: new Date().toISOString(),
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ salesOrderLineId: order.lines[0].id, uom: 'each', quantityShipped: 6 }]
  });
  const container = await createShippingContainer(harness.tenantId, {
    salesOrderShipmentId: shipment.id,
    packageRef: 'BOX-FL'
  });
  await addShippingContainerItem(harness.tenantId, container.id, {
    pickTaskId: tasks[0].id,
    salesOrderLineId: order.lines[0].id,
    itemId: item.id,
    uom: 'each',
    quantity: 6
  });
  await sealShippingContainer(harness.tenantId, container.id);

  // Ship via shipContainer (triggers inventory movement internally)
  const shipped = await shipContainer(harness.tenantId, container.id, {
    idempotencyKey: `fl-ship:${randomUUID()}`,
    actor: { type: 'system', id: null }
  });
  assert.equal(shipped.status, 'shipped');
  assert.ok(shipped.shippedAt != null);

  // Conservation: on_hand reduced by 6, no residual reserved or allocated
  const bFinal = await readBalance(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(bFinal.onHand, 4);
  assert.equal(bFinal.reserved, 0);
  assert.equal(bFinal.allocated, 0);

  // Reservation fulfilled
  const reservation = await getReservation(harness.tenantId, reservations[0].id, topology.warehouse.id);
  assert.equal(reservation.status, 'FULFILLED');

  // Ledger movement is an issue record
  const shipmentRow = await harness.pool.query(
    `SELECT inventory_movement_id FROM sales_order_shipments WHERE id = $1 AND tenant_id = $2`,
    [shipment.id, harness.tenantId]
  );
  assert.ok(shipmentRow.rows[0].inventory_movement_id != null);
  const mvt = await harness.pool.query(
    `SELECT movement_type, status FROM inventory_movements WHERE id = $1 AND tenant_id = $2`,
    [shipmentRow.rows[0].inventory_movement_id, harness.tenantId]
  );
  assert.equal(mvt.rows[0].movement_type, 'issue');
  assert.equal(mvt.rows[0].status, 'posted');
});

// ─── G: Partial shipment correctness ─────────────────────────────────────────

test('partial shipment: picking and shipping less than ordered leaves correct residual balance', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp6-partial-ship',
    tenantName: 'WP6 Partial Ship'
  });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'PART-SHIP',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 6
  });
  const customer = await harness.createCustomer('PSHIP');
  const order = await harness.createSalesOrder({
    soNumber: `SO-PSHIP-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 10 }]
  });

  // Reserve and allocate all 10
  const reservations = await createReservations(
    harness.tenantId,
    {
      reservations: [{
        demandType: 'sales_order_line',
        demandId: order.lines[0].id,
        itemId: item.id,
        locationId: topology.defaults.SELLABLE.id,
        warehouseId: topology.warehouse.id,
        uom: 'each',
        quantityReserved: 10
      }]
    },
    { idempotencyKey: `pship-res:${randomUUID()}` }
  );
  await allocateReservation(harness.tenantId, reservations[0].id, topology.warehouse.id, {
    idempotencyKey: `pship-alloc:${randomUUID()}`
  });

  // Pick only 7
  const { tasks } = await createWave(harness.tenantId, [order.id]);
  await confirmPickTask(harness.tenantId, tasks[0].id, { quantityPicked: 7 });

  // Ship only 7 (partial)
  const shipment = await harness.createShipment({
    salesOrderId: order.id,
    shippedAt: new Date().toISOString(),
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ salesOrderLineId: order.lines[0].id, uom: 'each', quantityShipped: 7 }]
  });
  const container = await createShippingContainer(harness.tenantId, {
    salesOrderShipmentId: shipment.id,
    packageRef: 'BOX-PSHIP'
  });
  await addShippingContainerItem(harness.tenantId, container.id, {
    pickTaskId: tasks[0].id,
    salesOrderLineId: order.lines[0].id,
    itemId: item.id,
    uom: 'each',
    quantity: 7
  });
  await sealShippingContainer(harness.tenantId, container.id);

  await shipContainer(harness.tenantId, container.id, {
    idempotencyKey: `pship-ship:${randomUUID()}`,
    actor: { type: 'system', id: null }
  });

  // 10 seeded, 7 shipped → 3 remain on-hand
  const bFinal = await readBalance(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(bFinal.onHand, 3);
  // 3 units remain allocated for the unfulfilled portion of the reservation (correct)
  assert.equal(bFinal.allocated, 3);
  assert.equal(bFinal.reserved, 0);
});
