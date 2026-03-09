import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';

test('receipt idempotent retry replays without duplicate ledger or cost rows', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-idempotency',
    tenantName: 'Truth Idempotency Retry'
  });
  const { tenantId, pool: db, topology } = harness;

  const vendor = await harness.createVendor('VIDEM');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'IDEMP',
    type: 'raw'
  });
  const purchaseOrder = await harness.createPurchaseOrder({
    vendorId: vendor.id,
    shipToLocationId: topology.defaults.SELLABLE.id,
    receivingLocationId: topology.defaults.SELLABLE.id,
    expectedDate: '2026-02-10',
    status: 'approved',
    lines: [
      {
        itemId: item.id,
        uom: 'each',
        quantityOrdered: 12,
        unitCost: 5.25,
        currencyCode: 'THB'
      }
    ]
  });

  const idempotencyKey = `truth-receipt:${randomUUID()}`;
  const first = await harness.postReceipt({
    purchaseOrderId: purchaseOrder.id,
    receivedAt: '2026-02-11T00:00:00.000Z',
    idempotencyKey,
    lines: [
      {
        purchaseOrderLineId: purchaseOrder.lines[0].id,
        uom: 'each',
        quantityReceived: 12,
        unitCost: 5.25
      }
    ]
  });
  const second = await harness.postReceipt({
    purchaseOrderId: purchaseOrder.id,
    receivedAt: '2026-02-11T00:00:00.000Z',
    idempotencyKey,
    lines: [
      {
        purchaseOrderLineId: purchaseOrder.lines[0].id,
        uom: 'each',
        quantityReceived: 12,
        unitCost: 5.25
      }
    ]
  });

  assert.equal(second.receipt.id, first.receipt.id);
  assert.equal(second.receipt.inventoryMovementId, first.receipt.inventoryMovementId);

  const movementId = first.receipt.inventoryMovementId;
  const receiptCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM purchase_order_receipts
      WHERE tenant_id = $1
        AND idempotency_key = $2`,
    [tenantId, idempotencyKey]
  );
  assert.equal(Number(receiptCount.rows[0]?.count ?? 0), 1);

  const movementCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, movementId]
  );
  assert.equal(Number(movementCount.rows[0]?.count ?? 0), 1);

  const costLayerCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND movement_id = $2`,
    [tenantId, movementId]
  );
  assert.equal(Number(costLayerCount.rows[0]?.count ?? 0), 1);

  const audit = await harness.auditReplayDeterminism(10);
  assert.equal(audit.movementAudit.replayIntegrityFailures.count, 0);
  assert.equal(audit.eventRegistryFailures.count, 0);
});
