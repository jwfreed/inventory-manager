import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { assertMovementContract } from './helpers/mutationContract.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  createReservations,
  getReservation
} = require('../../src/services/orderToCash.service.ts');

async function readReservedAllocated(harness, itemId, locationId, uom = 'each') {
  const result = await harness.pool.query(
    `SELECT COALESCE(reserved, 0)::numeric AS reserved,
            COALESCE(allocated, 0)::numeric AS allocated
       FROM inventory_balance
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = $4`,
    [harness.tenantId, itemId, locationId, uom]
  );
  return {
    reserved: Number(result.rows[0]?.reserved ?? 0),
    allocated: Number(result.rows[0]?.allocated ?? 0)
  };
}

test('shipment contract writes ledger, emits events, updates projections, and replays cleanly', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'contract-shipment', tenantName: 'Contract Shipment' });
  const { topology } = harness;
  const customer = await harness.createCustomer('SHIP');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'SHIP',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 4
  });
  const order = await harness.createSalesOrder({
    soNumber: `SO-CONTRACT-SHIP-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 4 }]
  });
  const shipment = await harness.createShipment({
    salesOrderId: order.id,
    shippedAt: '2026-03-01T00:00:00.000Z',
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ salesOrderLineId: order.lines[0].id, uom: 'each', quantityShipped: 4 }]
  });
  const posted = await harness.postShipment(shipment.id, {
    idempotencyKey: 'contract-shipment-post',
    actor: { type: 'system', id: null }
  });

  await assertMovementContract({
    harness,
    movementId: posted.inventoryMovementId,
    expectedMovementType: 'issue',
    expectedSourceType: 'shipment_post',
    expectedLineCount: 1,
    expectedBalances: [{ itemId: item.id, locationId: topology.defaults.SELLABLE.id, onHand: 1 }]
  });
});

test('shipment create without autoAllocateReservations leaves matching reservations reserved', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'contract-ship-create', tenantName: 'Shipment Create Tenant' });
  const { topology } = harness;
  const customer = await harness.createCustomer('SHIP-CREATE');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'SHIP-CREATE',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 8,
    unitCost: 5
  });

  const order = await harness.createSalesOrder({
    soNumber: `SO-CREATE-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 4 }]
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
        quantityReserved: 4
      }]
    },
    { idempotencyKey: `reservation:${randomUUID()}` }
  );

  await harness.createShipment({
    salesOrderId: order.id,
    shippedAt: '2026-03-01T00:00:00.000Z',
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ salesOrderLineId: order.lines[0].id, uom: 'each', quantityShipped: 4 }]
  });

  const reservation = await getReservation(harness.tenantId, reservations[0].id, topology.warehouse.id);
  const balances = await readReservedAllocated(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(reservation?.status, 'RESERVED');
  assert.equal(balances.reserved, 4);
  assert.equal(balances.allocated, 0);
});

test('shipment create with autoAllocateReservations allocates matching reservations and shipment post still fulfills them', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'contract-ship-auto', tenantName: 'Shipment Auto Allocate Tenant' });
  const { topology } = harness;
  const customer = await harness.createCustomer('SHIP-AUTO');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'SHIP-AUTO',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 6,
    unitCost: 6
  });

  const order = await harness.createSalesOrder({
    soNumber: `SO-AUTO-${randomUUID().slice(0, 8)}`,
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
    { idempotencyKey: `reservation:${randomUUID()}` }
  );

  const shipment = await harness.createShipment({
    salesOrderId: order.id,
    shippedAt: '2026-03-02T00:00:00.000Z',
    shipFromLocationId: topology.defaults.SELLABLE.id,
    autoAllocateReservations: true,
    lines: [{ salesOrderLineId: order.lines[0].id, uom: 'each', quantityShipped: 5 }]
  });

  const allocatedReservation = await getReservation(harness.tenantId, reservations[0].id, topology.warehouse.id);
  const allocatedBalances = await readReservedAllocated(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(allocatedReservation?.status, 'ALLOCATED');
  assert.equal(allocatedBalances.reserved, 0);
  assert.equal(allocatedBalances.allocated, 5);

  const posted = await harness.postShipment(shipment.id, {
    idempotencyKey: `shipment-post:${randomUUID()}`,
    actor: { type: 'system', id: null }
  });
  await assertMovementContract({
    harness,
    movementId: posted.inventoryMovementId,
    expectedMovementType: 'issue',
    expectedSourceType: 'shipment_post',
    expectedLineCount: 1,
    expectedBalances: [{ itemId: item.id, locationId: topology.defaults.SELLABLE.id, onHand: 1 }]
  });

  const fulfilledReservation = await getReservation(harness.tenantId, reservations[0].id, topology.warehouse.id);
  const fulfilledBalances = await readReservedAllocated(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(fulfilledReservation?.status, 'FULFILLED');
  assert.equal(Number(fulfilledReservation?.quantityFulfilled ?? 0), 5);
  assert.equal(fulfilledBalances.reserved, 0);
  assert.equal(fulfilledBalances.allocated, 0);
});

test('shipment auto-allocation does not over-allocate when the reservation exceeds the shipment quantity', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'contract-ship-partial', tenantName: 'Shipment Partial Allocate Tenant' });
  const { topology } = harness;
  const customer = await harness.createCustomer('SHIP-PARTIAL');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'SHIP-PARTIAL',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 7
  });

  const order = await harness.createSalesOrder({
    soNumber: `SO-PART-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 6 }]
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
        quantityReserved: 6
      }]
    },
    { idempotencyKey: `reservation:${randomUUID()}` }
  );

  await harness.createShipment({
    salesOrderId: order.id,
    shippedAt: '2026-03-03T00:00:00.000Z',
    shipFromLocationId: topology.defaults.SELLABLE.id,
    autoAllocateReservations: true,
    lines: [{ salesOrderLineId: order.lines[0].id, uom: 'each', quantityShipped: 2 }]
  });

  const reservation = await getReservation(harness.tenantId, reservations[0].id, topology.warehouse.id);
  const balances = await readReservedAllocated(harness, item.id, topology.defaults.SELLABLE.id);
  assert.equal(reservation?.status, 'RESERVED');
  assert.equal(balances.reserved, 6);
  assert.equal(balances.allocated, 0);
});

test('duplicate shipment create with autoAllocateReservations does not double-allocate reservations', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'contract-ship-repeat', tenantName: 'Shipment Repeat Tenant' });
  const { topology } = harness;
  const customer = await harness.createCustomer('SHIP-REPEAT');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'SHIP-REPEAT',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 9,
    unitCost: 3
  });

  const order = await harness.createSalesOrder({
    soNumber: `SO-REPEAT-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 3 }]
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
        quantityReserved: 3
      }]
    },
    { idempotencyKey: `reservation:${randomUUID()}` }
  );

  const firstShipment = await harness.createShipment({
    salesOrderId: order.id,
    shippedAt: '2026-03-04T00:00:00.000Z',
    shipFromLocationId: topology.defaults.SELLABLE.id,
    autoAllocateReservations: true,
    lines: [{ salesOrderLineId: order.lines[0].id, uom: 'each', quantityShipped: 3 }]
  });
  const secondShipment = await harness.createShipment({
    salesOrderId: order.id,
    shippedAt: '2026-03-04T00:05:00.000Z',
    shipFromLocationId: topology.defaults.SELLABLE.id,
    autoAllocateReservations: true,
    lines: [{ salesOrderLineId: order.lines[0].id, uom: 'each', quantityShipped: 3 }]
  });

  const reservation = await getReservation(harness.tenantId, reservations[0].id, topology.warehouse.id);
  const balances = await readReservedAllocated(harness, item.id, topology.defaults.SELLABLE.id);
  assert.notEqual(firstShipment.id, secondShipment.id);
  assert.equal(reservation?.status, 'ALLOCATED');
  assert.equal(balances.reserved, 0);
  assert.equal(balances.allocated, 3);
});
