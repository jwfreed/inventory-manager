import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';

async function createPostedReceiptInQa(harness, { itemId, quantity, unitCost = 5 }) {
  const vendor = await harness.createVendor('TRUTH-SEQ');
  const purchaseOrder = await harness.createPurchaseOrder({
    vendorId: vendor.id,
    shipToLocationId: harness.topology.defaults.SELLABLE.id,
    receivingLocationId: harness.topology.defaults.SELLABLE.id,
    expectedDate: '2026-03-06',
    status: 'approved',
    lines: [
      {
        itemId,
        uom: 'each',
        quantityOrdered: quantity,
        unitCost,
        currencyCode: 'THB'
      }
    ]
  });

  const result = await harness.postReceipt({
    purchaseOrderId: purchaseOrder.id,
    receivedAt: '2026-03-06T00:00:00.000Z',
    receivedToLocationId: harness.topology.defaults.QA.id,
    idempotencyKey: `truth-seq-receipt:${randomUUID()}`,
    lines: [
      {
        purchaseOrderLineId: purchaseOrder.lines[0].id,
        uom: 'each',
        quantityReceived: quantity,
        unitCost
      }
    ]
  });
  return result.receipt;
}

test('receive to QA rejects downstream transfer from sellable before the prerequisite move exists', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-seq-receive-move',
    tenantName: 'Truth Sequencing Receive Move'
  });
  const { tenantId, pool: db, topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'TRUTH-SEQ-RM',
    type: 'raw'
  });
  await createPostedReceiptInQa(harness, { itemId: item.id, quantity: 5 });
  const store = await harness.createWarehouseWithSellable('TRUTH-SEQ-RM-STORE');
  const idempotencyKey = `truth-seq-rm:${randomUUID()}`;

  await assert.rejects(
    harness.postTransfer({
      sourceLocationId: topology.defaults.SELLABLE.id,
      destinationLocationId: store.sellable.id,
      itemId: item.id,
      quantity: 1,
      uom: 'each',
      reasonCode: 'truth_seq_invalid_order',
      notes: 'must fail before QA stock is moved',
      idempotencyKey
    }),
    (error) => {
      assert.equal(error?.code ?? error?.message, 'INSUFFICIENT_STOCK');
      return true;
    }
  );

  const movementResult = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND idempotency_key = $2`,
    [tenantId, idempotencyKey]
  );
  assert.equal(Number(movementResult.rows[0]?.count ?? 0), 0);
  assert.equal(await harness.readOnHand(item.id, topology.defaults.SELLABLE.id), 0);
  assert.equal(await harness.readOnHand(item.id, topology.defaults.QA.id), 5);
});

test('move then issue from the stale source location is rejected with zero partial writes', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-seq-move-issue',
    tenantName: 'Truth Sequencing Move Issue'
  });
  const { tenantId, pool: db, topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'TRUTH-SEQ-MI',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 4,
    unitCost: 6
  });
  const store = await harness.createWarehouseWithSellable('TRUTH-SEQ-MI-STORE');
  await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId: item.id,
    quantity: 4,
    uom: 'each',
    reasonCode: 'truth_seq_move',
    notes: 'move all stock away first',
    idempotencyKey: `truth-seq-mi-transfer:${randomUUID()}`
  });

  const adjustment = await harness.createInventoryAdjustmentDraft(
    {
      occurredAt: '2026-03-07T00:00:00.000Z',
      reasonCode: 'truth_seq_issue',
      lines: [
        {
          lineNumber: 1,
          itemId: item.id,
          locationId: topology.defaults.SELLABLE.id,
          uom: 'each',
          quantityDelta: -1,
          reasonCode: 'truth_seq_issue'
        }
      ]
    },
    { type: 'system', id: null }
  );

  await assert.rejects(
    harness.postInventoryAdjustmentDraft(adjustment.id, { type: 'system', id: null }),
    (error) => {
      assert.equal(error?.code ?? error?.message, 'INSUFFICIENT_STOCK');
      return true;
    }
  );

  const movementResult = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = 'inventory_adjustment_post'
        AND source_id = $2`,
    [tenantId, adjustment.id]
  );
  assert.equal(Number(movementResult.rows[0]?.count ?? 0), 0);

  const adjustmentResult = await db.query(
    `SELECT status, inventory_movement_id
       FROM inventory_adjustments
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, adjustment.id]
  );
  assert.equal(adjustmentResult.rows[0]?.status, 'draft');
  assert.equal(adjustmentResult.rows[0]?.inventory_movement_id, null);
  assert.equal(await harness.readOnHand(item.id, topology.defaults.SELLABLE.id), 0);
  assert.equal(await harness.readOnHand(item.id, store.sellable.id), 4);
});

test('receipt reversal after downstream consumption is rejected with no reversal movement', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-seq-reversal-consume',
    tenantName: 'Truth Sequencing Reversal Consume'
  });
  const { tenantId, pool: db, topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'TRUTH-SEQ-RC',
    type: 'raw'
  });
  const receipt = await createPostedReceiptInQa(harness, { itemId: item.id, quantity: 3 });

  const adjustment = await harness.createInventoryAdjustmentDraft(
    {
      occurredAt: '2026-03-08T00:00:00.000Z',
      reasonCode: 'truth_seq_consume',
      lines: [
        {
          lineNumber: 1,
          itemId: item.id,
          locationId: topology.defaults.QA.id,
          uom: 'each',
          quantityDelta: -1,
          reasonCode: 'truth_seq_consume'
        }
      ]
    },
    { type: 'system', id: null }
  );
  await harness.postInventoryAdjustmentDraft(adjustment.id, { type: 'system', id: null });

  await assert.rejects(
    harness.voidReceipt(receipt.id, {
      reason: 'must fail after downstream consumption',
      actor: { type: 'system', id: null }
    }),
    (error) => {
      assert.equal(error?.code ?? error?.message, 'RECEIPT_REVERSAL_NOT_POSSIBLE_CONSUMED');
      return true;
    }
  );

  const reversalResult = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND reversal_of_movement_id = $2`,
    [tenantId, receipt.inventoryMovementId]
  );
  assert.equal(Number(reversalResult.rows[0]?.count ?? 0), 0);
});

test('cross-domain invalid transition fails loud after output leaves QA', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-seq-cross-domain',
    tenantName: 'Truth Sequencing Cross Domain'
  });
  const { tenantId, pool: db, topology } = harness;

  const component = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'TRUTH-SEQ-CD-RAW',
    type: 'raw'
  });
  const output = await harness.createItem({
    defaultLocationId: topology.defaults.QA.id,
    skuPrefix: 'TRUTH-SEQ-CD-FG',
    type: 'finished'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: component.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 40,
    unitCost: 8
  });

  const bom = await harness.createBomAndActivate({
    outputItemId: output.id,
    components: [{ componentItemId: component.id, quantityPer: 2 }],
    suffix: randomUUID().slice(0, 6)
  });
  const workOrder = await harness.createWorkOrder({
    kind: 'production',
    outputItemId: output.id,
    outputUom: 'each',
    quantityPlanned: 20,
    bomId: bom.id,
    defaultConsumeLocationId: topology.defaults.SELLABLE.id,
    defaultProduceLocationId: topology.defaults.QA.id
  });

  const reportKey = `truth-seq-cross-report:${randomUUID()}`;
  const report = await harness.reportProduction(
    workOrder.id,
    {
      warehouseId: topology.warehouse.id,
      outputQty: 20,
      outputUom: 'each',
      occurredAt: '2026-03-09T00:00:00.000Z',
      idempotencyKey: reportKey
    },
    {},
    { idempotencyKey: reportKey }
  );

  const qcAcceptKey = `truth-seq-cross-qc:${randomUUID()}`;
  const qcAccept = await harness.qcWarehouseDisposition(
    'accept',
    {
      warehouseId: topology.warehouse.id,
      itemId: output.id,
      quantity: 5,
      uom: 'each',
      idempotencyKey: qcAcceptKey
    },
    { type: 'system', id: null },
    { idempotencyKey: qcAcceptKey }
  );
  assert.equal(qcAccept.action, 'accept');

  await assert.rejects(
    harness.voidProductionReport(
      workOrder.id,
      {
        workOrderExecutionId: report.productionReportId,
        reason: 'must fail after cross-domain move',
        idempotencyKey: `truth-seq-cross-void:${randomUUID()}`
      },
      { type: 'system', id: null }
    ),
    (error) => {
      assert.equal(error?.code ?? error?.message, 'WO_VOID_OUTPUT_ALREADY_MOVED');
      return true;
    }
  );

  const voidMovementResult = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_id = $2
        AND source_type IN ('work_order_batch_void_components', 'work_order_batch_void_output')`,
    [tenantId, report.productionReportId]
  );
  assert.equal(Number(voidMovementResult.rows[0]?.count ?? 0), 0);
});
