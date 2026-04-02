import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from './helpers/service-harness.mjs';

async function readMovement(db, tenantId, movementId) {
  const movementResult = await db.query(
    `SELECT movement_deterministic_hash
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, movementId]
  );
  assert.equal(movementResult.rowCount, 1);

  const lineResult = await db.query(
    `SELECT item_id,
            location_id,
            COALESCE(canonical_uom, uom) AS balance_uom,
            COALESCE(quantity_delta_canonical, quantity_delta)::numeric AS effective_quantity
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
      ORDER BY item_id ASC, location_id ASC, COALESCE(canonical_uom, uom) ASC, id ASC`,
    [tenantId, movementId]
  );

  return {
    deterministicHash: movementResult.rows[0].movement_deterministic_hash,
    lines: lineResult.rows.map((row) => ({
      itemId: row.item_id,
      locationId: row.location_id,
      uom: row.balance_uom,
      quantity: Number(row.effective_quantity ?? 0)
    }))
  };
}

function lineQuantityAt(lines, locationId) {
  return lines
    .filter((line) => line.locationId === locationId)
    .reduce((sum, line) => sum + line.quantity, 0);
}

function sumInbound(lines) {
  return lines
    .filter((line) => line.quantity > 0)
    .reduce((sum, line) => sum + line.quantity, 0);
}

function sumOutbound(lines) {
  return lines
    .filter((line) => line.quantity < 0)
    .reduce((sum, line) => sum + Math.abs(line.quantity), 0);
}

function aggregateNet(lines) {
  const byKey = new Map();
  for (const line of lines) {
    const key = `${line.itemId}|${line.locationId}|${line.uom}`;
    byKey.set(key, (byKey.get(key) ?? 0) + line.quantity);
  }
  return byKey;
}

async function createReceiptFixture(harness, quantity, idempotencyKey) {
  const vendor = await harness.createVendor('INV');
  const item = await harness.createItem({
    defaultLocationId: harness.topology.defaults.SELLABLE.id,
    skuPrefix: 'INV-R',
    type: 'raw'
  });
  const purchaseOrder = await harness.createPurchaseOrder({
    vendorId: vendor.id,
    shipToLocationId: harness.topology.defaults.SELLABLE.id,
    receivingLocationId: harness.topology.defaults.SELLABLE.id,
    expectedDate: '2026-01-10',
    status: 'approved',
    lines: [
      {
        itemId: item.id,
        uom: 'each',
        quantityOrdered: quantity,
        unitCost: 5,
        currencyCode: 'THB'
      }
    ]
  });
  const receiptResult = await harness.postReceipt({
    purchaseOrderId: purchaseOrder.id,
    receivedAt: '2026-01-11T00:00:00.000Z',
    lines: [
      {
        purchaseOrderLineId: purchaseOrder.lines[0].id,
        uom: 'each',
        quantityReceived: quantity,
        unitCost: 5
      }
    ],
    idempotencyKey
  });
  return {
    item,
    purchaseOrder,
    receipt: receiptResult.receipt
  };
}

test('shared inventory mutation invariants stay aligned across receipt, transfer, and reversal flows', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'inventory-invariants',
    tenantName: 'Inventory Invariants'
  });
  const { pool: db, tenantId, topology } = harness;

  const receiptKey = `receipt:${tenantId}:${randomUUID()}`;
  const receiptFixture = await createReceiptFixture(harness, 8, receiptKey);
  const replayedReceipt = await harness.postReceipt({
    purchaseOrderId: receiptFixture.purchaseOrder.id,
    receivedAt: '2026-01-11T00:00:00.000Z',
    lines: [
      {
        purchaseOrderLineId: receiptFixture.purchaseOrder.lines[0].id,
        uom: 'each',
        quantityReceived: 8,
        unitCost: 5
      }
    ],
    idempotencyKey: receiptKey
  });

  assert.equal(replayedReceipt.receipt.id, receiptFixture.receipt.id);
  assert.equal(replayedReceipt.receipt.inventoryMovementId, receiptFixture.receipt.inventoryMovementId);

  const receiptMovement = await readMovement(db, tenantId, receiptFixture.receipt.inventoryMovementId);
  assert.ok(receiptMovement.deterministicHash);
  assert.equal(receiptMovement.lines.length, 1);
  assert.equal(sumInbound(receiptMovement.lines), 8);
  assert.equal(sumOutbound(receiptMovement.lines), 0);
  assert.equal(await harness.readOnHand(receiptFixture.item.id, topology.defaults.QA.id), 8);

  const destinationWarehouse = await harness.createWarehouseWithSellable(`INV-${randomUUID().slice(0, 6)}`);
  const transferItem = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'INV-T',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: transferItem.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 9,
    unitCost: 4,
    countedAt: '2026-01-01T00:00:00.000Z'
  });

  const sourceBeforeTransfer = await harness.readOnHand(transferItem.id, topology.defaults.SELLABLE.id);
  const destinationBeforeTransfer = await harness.readOnHand(transferItem.id, destinationWarehouse.sellable.id);
  const transferKey = `transfer:${tenantId}:${randomUUID()}`;
  const transfer = await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: destinationWarehouse.sellable.id,
    itemId: transferItem.id,
    quantity: 4,
    uom: 'each',
    reasonCode: 'inventory_invariants',
    notes: 'inventory invariants transfer',
    idempotencyKey: transferKey
  });
  const replayedTransfer = await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: destinationWarehouse.sellable.id,
    itemId: transferItem.id,
    quantity: 4,
    uom: 'each',
    reasonCode: 'inventory_invariants',
    notes: 'inventory invariants transfer',
    idempotencyKey: transferKey
  });

  assert.equal(replayedTransfer.movementId, transfer.movementId);

  const transferMovement = await readMovement(db, tenantId, transfer.movementId);
  assert.ok(transferMovement.deterministicHash);
  assert.equal(transferMovement.lines.length, 2);
  assert.equal(sumOutbound(transferMovement.lines), 4);
  assert.equal(sumInbound(transferMovement.lines), 4);
  assert.equal(
    await harness.readOnHand(transferItem.id, topology.defaults.SELLABLE.id),
    sourceBeforeTransfer + lineQuantityAt(transferMovement.lines, topology.defaults.SELLABLE.id)
  );
  assert.equal(
    await harness.readOnHand(transferItem.id, destinationWarehouse.sellable.id),
    destinationBeforeTransfer + lineQuantityAt(transferMovement.lines, destinationWarehouse.sellable.id)
  );

  const sourceAfterTransfer = await harness.readOnHand(transferItem.id, topology.defaults.SELLABLE.id);
  const destinationAfterTransfer = await harness.readOnHand(transferItem.id, destinationWarehouse.sellable.id);
  const voidKey = `transfer-void:${tenantId}:${randomUUID()}`;
  const reversal = await harness.voidTransfer(transfer.movementId, {
    reason: 'inventory_invariants_void',
    actor: { type: 'system', id: null },
    idempotencyKey: voidKey
  });
  const replayedReversal = await harness.voidTransfer(transfer.movementId, {
    reason: 'inventory_invariants_void',
    actor: { type: 'system', id: null },
    idempotencyKey: voidKey
  });

  assert.equal(replayedReversal.reversalMovementId, reversal.reversalMovementId);

  const reversalMovement = await readMovement(db, tenantId, reversal.reversalMovementId);
  assert.ok(reversalMovement.deterministicHash);
  assert.equal(reversalMovement.lines.length, 2);
  assert.equal(sumOutbound(reversalMovement.lines), 4);
  assert.equal(sumInbound(reversalMovement.lines), 4);

  const netByKey = aggregateNet([...transferMovement.lines, ...reversalMovement.lines]);
  for (const [key, netQuantity] of netByKey.entries()) {
    assert.ok(Math.abs(netQuantity) < 1e-6, `expected ${key} to net to zero, got ${netQuantity}`);
  }

  assert.equal(
    await harness.readOnHand(transferItem.id, topology.defaults.SELLABLE.id),
    sourceAfterTransfer + lineQuantityAt(reversalMovement.lines, topology.defaults.SELLABLE.id)
  );
  assert.equal(
    await harness.readOnHand(transferItem.id, destinationWarehouse.sellable.id),
    destinationAfterTransfer + lineQuantityAt(reversalMovement.lines, destinationWarehouse.sellable.id)
  );
  assert.equal(await harness.readOnHand(transferItem.id, topology.defaults.SELLABLE.id), sourceBeforeTransfer);
  assert.equal(await harness.readOnHand(transferItem.id, destinationWarehouse.sellable.id), destinationBeforeTransfer);

  const replayAudit = await harness.auditReplayDeterminism(10);
  assert.equal(replayAudit.movementAudit.rowsMissingDeterministicHash, 0);
  assert.equal(replayAudit.movementAudit.postCutoffRowsMissingHash, 0);
  assert.equal(replayAudit.movementAudit.replayIntegrityFailures.count, 0);
  assert.equal(replayAudit.eventRegistryFailures.count, 0);

  const balanceMismatches = await harness.findQuantityConservationMismatches();
  assert.deepEqual(balanceMismatches, []);
});
