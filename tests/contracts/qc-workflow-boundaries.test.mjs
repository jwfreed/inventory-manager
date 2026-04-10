import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServiceHarness } from '../helpers/service-harness.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { createQcEvent } = require('../../src/services/qc.service.ts');

async function createReceiptInQa(harness, { quantity, unitCost = 5, uom = 'each' }) {
  const item = await harness.createItem({
    defaultLocationId: harness.topology.defaults.SELLABLE.id,
    skuPrefix: `QC-REC-${randomUUID().slice(0, 6)}`,
    type: 'raw',
    defaultUom: uom,
    canonicalUom: uom,
    stockingUom: uom
  });
  const vendor = await harness.createVendor('QC-REC');
  const receipt = await harness.createReceipt({
    vendorId: vendor.id,
    itemId: item.id,
    locationId: harness.topology.defaults.QA.id,
    quantity,
    unitCost,
    uom,
    idempotencyKey: `qc-receipt:${randomUUID()}`
  });
  return {
    item,
    receipt,
    receiptLineId: receipt.lines[0].id
  };
}

async function loadReceiptAllocations(db, tenantId, receiptLineId) {
  const res = await db.query(
    `SELECT id,
            location_id AS "locationId",
            bin_id AS "binId",
            inventory_movement_id AS "movementId",
            inventory_movement_line_id AS "movementLineId",
            status,
            quantity::numeric AS quantity
       FROM receipt_allocations
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = $2
      ORDER BY created_at ASC, id ASC`,
    [tenantId, receiptLineId]
  );
  return res.rows.map((row) => ({
    ...row,
    quantity: Number(row.quantity)
  }));
}

async function loadReceiptLifecycle(db, tenantId, receiptId) {
  const res = await db.query(
    `SELECT status, lifecycle_state
       FROM purchase_order_receipts
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, receiptId]
  );
  return res.rows[0] ?? null;
}

async function countAuditRows(db, tenantId, entityType, entityId) {
  const res = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM audit_log
      WHERE tenant_id = $1
        AND entity_type = $2
        AND entity_id = $3`,
    [tenantId, entityType, entityId]
  );
  return Number(res.rows[0]?.count ?? 0);
}

async function countQcEventsForSource(db, tenantId, clause, sourceId) {
  const res = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM qc_events
      WHERE tenant_id = $1
        AND ${clause} = $2`,
    [tenantId, sourceId]
  );
  return Number(res.rows[0]?.count ?? 0);
}

async function createDisassemblyWorkOrder(harness, outputItemId, options = {}) {
  return harness.createWorkOrder({
    kind: 'disassembly',
    outputItemId,
    outputUom: options.outputUom ?? 'each',
    quantityPlanned: options.quantityPlanned ?? 1,
    quantityCompleted: options.quantityCompleted,
    defaultConsumeLocationId: options.defaultConsumeLocationId ?? harness.topology.defaults.SELLABLE.id,
    defaultProduceLocationId: options.defaultProduceLocationId ?? harness.topology.defaults.QA.id,
    description: options.description ?? 'QC characterization work order'
  });
}

async function createExecutionLineFixture(harness, { quantity = 3, uom = 'each' } = {}) {
  const output = await harness.createItem({
    defaultLocationId: harness.topology.defaults.QA.id,
    skuPrefix: `QC-EXEC-${randomUUID().slice(0, 6)}`,
    type: 'finished',
    defaultUom: uom,
    canonicalUom: uom,
    stockingUom: uom
  });
  const workOrder = await createDisassemblyWorkOrder(harness, output.id, {
    quantityPlanned: quantity,
    outputUom: uom
  });
  const completion = await harness.createWorkOrderCompletionDraft(
    workOrder.id,
    {
      occurredAt: '2026-03-12T00:00:00.000Z',
      lines: [
        {
          outputItemId: output.id,
          toLocationId: harness.topology.defaults.QA.id,
          uom,
          quantityCompleted: quantity
        }
      ]
    },
    { idempotencyKey: `qc-execution-draft:${randomUUID()}` }
  );
  const lineRes = await harness.pool.query(
    `SELECT id
       FROM work_order_execution_lines
      WHERE tenant_id = $1
        AND work_order_execution_id = $2
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [harness.tenantId, completion.id]
  );
  assert.equal(lineRes.rowCount, 1);
  return {
    output,
    workOrder,
    completion,
    executionLineId: lineRes.rows[0].id
  };
}

async function deleteWarehouseDefaultRole(db, tenantId, warehouseId, role) {
  await db.query(
    `DELETE FROM warehouse_default_location
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND role = $3`,
    [tenantId, warehouseId, role]
  );
}

test('receipt QC characterization preserves allocation movement, lifecycle transitions, NCR creation, and replay', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-receipt',
    tenantName: 'Contract QC Receipt'
  });
  const { tenantId, pool: db, topology } = harness;

  const accepted = await createReceiptInQa(harness, { quantity: 5 });
  const initialAllocations = await loadReceiptAllocations(db, tenantId, accepted.receiptLineId);
  assert.equal(initialAllocations.length, 1);
  assert.equal(initialAllocations[0].status, 'QA');
  assert.ok(Math.abs(initialAllocations[0].quantity - 5) < 1e-6);

  const acceptKey = `qc-receipt-accept:${randomUUID()}`;
  const acceptedFirst = await createQcEvent(
    tenantId,
    {
      purchaseOrderReceiptLineId: accepted.receiptLineId,
      eventType: 'accept',
      quantity: 5,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: acceptKey }
  );
  const acceptedReplay = await createQcEvent(
    tenantId,
    {
      purchaseOrderReceiptLineId: accepted.receiptLineId,
      eventType: 'accept',
      quantity: 5,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: acceptKey }
  );

  assert.equal(acceptedFirst.replayed, false);
  assert.equal(acceptedReplay.replayed, true);
  assert.equal(acceptedReplay.eventId, acceptedFirst.eventId);
  assert.equal(acceptedReplay.movementId, acceptedFirst.movementId);
  assert.equal(
    await countQcEventsForSource(db, tenantId, 'purchase_order_receipt_line_id', accepted.receiptLineId),
    1
  );
  assert.equal(await countAuditRows(db, tenantId, 'qc_event', acceptedFirst.eventId), 1);

  const acceptedAllocations = await loadReceiptAllocations(db, tenantId, accepted.receiptLineId);
  assert.equal(acceptedAllocations.length, 1);
  assert.equal(acceptedAllocations[0].status, 'AVAILABLE');
  assert.equal(acceptedAllocations[0].locationId, topology.defaults.SELLABLE.id);
  assert.equal(acceptedAllocations[0].movementId, acceptedFirst.movementId);
  assert.ok(Math.abs(acceptedAllocations[0].quantity - 5) < 1e-6);

  const acceptedLifecycle = await loadReceiptLifecycle(db, tenantId, accepted.receipt.id);
  assert.equal(acceptedLifecycle?.status, 'posted');
  assert.equal(acceptedLifecycle?.lifecycle_state, 'QC_COMPLETED');

  await assert.rejects(
    createQcEvent(
      tenantId,
      {
        purchaseOrderReceiptLineId: accepted.receiptLineId,
        eventType: 'accept',
        quantity: 1,
        uom: 'each',
        actorType: 'system'
      },
      { idempotencyKey: `qc-receipt-overcap:${randomUUID()}` }
    ),
    (error) => {
      assert.equal(error?.message, 'QC_EXCEEDS_RECEIPT');
      return true;
    }
  );

  const rejected = await createReceiptInQa(harness, { quantity: 4 });
  const rejectResult = await createQcEvent(
    tenantId,
    {
      purchaseOrderReceiptLineId: rejected.receiptLineId,
      eventType: 'reject',
      quantity: 4,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `qc-receipt-reject:${randomUUID()}` }
  );
  const rejectedAllocations = await loadReceiptAllocations(db, tenantId, rejected.receiptLineId);
  assert.equal(rejectedAllocations.length, 1);
  assert.equal(rejectedAllocations[0].status, 'HOLD');
  assert.equal(rejectedAllocations[0].locationId, topology.defaults.REJECT.id);
  assert.equal(rejectedAllocations[0].movementId, rejectResult.movementId);
  const rejectedLifecycle = await loadReceiptLifecycle(db, tenantId, rejected.receipt.id);
  assert.equal(rejectedLifecycle?.lifecycle_state, 'REJECTED');
  const ncrRes = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM ncrs
      WHERE tenant_id = $1
        AND qc_event_id = $2`,
    [tenantId, rejectResult.eventId]
  );
  assert.equal(Number(ncrRes.rows[0]?.count ?? 0), 1);
});

test('receipt QC characterization preserves receipt status and UOM eligibility guards', { timeout: 180000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-receipt-guards',
    tenantName: 'Contract QC Receipt Guards'
  });
  const { tenantId } = harness;

  const mismatched = await createReceiptInQa(harness, { quantity: 2 });
  await assert.rejects(
    createQcEvent(
      tenantId,
      {
        purchaseOrderReceiptLineId: mismatched.receiptLineId,
        eventType: 'accept',
        quantity: 1,
        uom: 'case',
        actorType: 'system'
      },
      { idempotencyKey: `qc-receipt-uom:${randomUUID()}` }
    ),
    (error) => {
      assert.equal(error?.message, 'QC_UOM_MISMATCH');
      return true;
    }
  );

  const voided = await createReceiptInQa(harness, { quantity: 2 });
  await harness.voidReceipt(voided.receipt.id, {
    reason: 'characterize qc void guard',
    actor: { type: 'system', id: null }
  });
  await assert.rejects(
    createQcEvent(
      tenantId,
      {
        purchaseOrderReceiptLineId: voided.receiptLineId,
        eventType: 'accept',
        quantity: 1,
        uom: 'each',
        actorType: 'system'
      },
      { idempotencyKey: `qc-receipt-voided:${randomUUID()}` }
    ),
    (error) => {
      assert.equal(error?.message, 'QC_RECEIPT_VOIDED');
      return true;
    }
  );
});

test('work order QC characterization preserves existence, UOM, conditional quantity caps, null bypass, and replay', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-wo',
    tenantName: 'Contract QC Work Order'
  });
  const { tenantId, pool: db } = harness;

  const cappedItem = await harness.createItem({
    defaultLocationId: harness.topology.defaults.QA.id,
    skuPrefix: `QC-WO-CAP-${randomUUID().slice(0, 6)}`,
    type: 'finished'
  });
  await harness.seedStockViaCount({
    warehouseId: harness.topology.warehouse.id,
    itemId: cappedItem.id,
    locationId: harness.topology.defaults.QA.id,
    quantity: 6,
    unitCost: 9
  });
  const cappedWorkOrder = await createDisassemblyWorkOrder(harness, cappedItem.id, {
    quantityPlanned: 10,
    quantityCompleted: 2
  });

  const cappedKey = `qc-wo-cap:${randomUUID()}`;
  const cappedFirst = await createQcEvent(
    tenantId,
    {
      workOrderId: cappedWorkOrder.id,
      eventType: 'accept',
      quantity: 2,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: cappedKey }
  );
  const cappedReplay = await createQcEvent(
    tenantId,
    {
      workOrderId: cappedWorkOrder.id,
      eventType: 'accept',
      quantity: 2,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: cappedKey }
  );

  assert.equal(cappedFirst.replayed, false);
  assert.equal(cappedReplay.replayed, true);
  assert.equal(cappedReplay.eventId, cappedFirst.eventId);
  assert.equal(cappedReplay.movementId, cappedFirst.movementId);
  assert.equal(await countAuditRows(db, tenantId, 'qc_event', cappedFirst.eventId), 1);

  await assert.rejects(
    createQcEvent(
      tenantId,
      {
        workOrderId: cappedWorkOrder.id,
        eventType: 'accept',
        quantity: 1,
        uom: 'each',
        actorType: 'system'
      },
      { idempotencyKey: `qc-wo-overcap:${randomUUID()}` }
    ),
    (error) => {
      assert.equal(error?.message, 'QC_EXCEEDS_WORK_ORDER');
      return true;
    }
  );

  await assert.rejects(
    createQcEvent(
      tenantId,
      {
        workOrderId: cappedWorkOrder.id,
        eventType: 'accept',
        quantity: 1,
        uom: 'kg',
        actorType: 'system'
      },
      { idempotencyKey: `qc-wo-uom:${randomUUID()}` }
    ),
    (error) => {
      assert.equal(error?.message, 'QC_UOM_MISMATCH');
      return true;
    }
  );

  await assert.rejects(
    createQcEvent(
      tenantId,
      {
        workOrderId: randomUUID(),
        eventType: 'accept',
        quantity: 1,
        uom: 'each',
        actorType: 'system'
      },
      { idempotencyKey: `qc-wo-missing:${randomUUID()}` }
    ),
    (error) => {
      assert.equal(error?.message, 'QC_WORK_ORDER_NOT_FOUND');
      return true;
    }
  );

  const uncappedItem = await harness.createItem({
    defaultLocationId: harness.topology.defaults.QA.id,
    skuPrefix: `QC-WO-NULL-${randomUUID().slice(0, 6)}`,
    type: 'finished'
  });
  await harness.seedStockViaCount({
    warehouseId: harness.topology.warehouse.id,
    itemId: uncappedItem.id,
    locationId: harness.topology.defaults.QA.id,
    quantity: 5,
    unitCost: 7
  });
  const uncappedWorkOrder = await createDisassemblyWorkOrder(harness, uncappedItem.id, {
    quantityPlanned: 1
  });
  const uncapped = await createQcEvent(
    tenantId,
    {
      workOrderId: uncappedWorkOrder.id,
      eventType: 'accept',
      quantity: 5,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `qc-wo-null-bypass:${randomUUID()}` }
  );
  assert.equal(uncapped.replayed, false);
  assert.ok(Math.abs(uncapped.quantity - 5) < 1e-6);
});

test('execution line QC characterization preserves existence, UOM, quantity caps, and replay', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-exec',
    tenantName: 'Contract QC Execution Line'
  });
  const { tenantId, pool: db } = harness;
  const fixture = await createExecutionLineFixture(harness, { quantity: 3 });

  await harness.seedStockViaCount({
    warehouseId: harness.topology.warehouse.id,
    itemId: fixture.output.id,
    locationId: harness.topology.defaults.QA.id,
    quantity: 3,
    unitCost: 11
  });

  const execKey = `qc-exec:${randomUUID()}`;
  const execFirst = await createQcEvent(
    tenantId,
    {
      workOrderExecutionLineId: fixture.executionLineId,
      eventType: 'accept',
      quantity: 3,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: execKey }
  );
  const execReplay = await createQcEvent(
    tenantId,
    {
      workOrderExecutionLineId: fixture.executionLineId,
      eventType: 'accept',
      quantity: 3,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: execKey }
  );

  assert.equal(execFirst.replayed, false);
  assert.equal(execReplay.replayed, true);
  assert.equal(execReplay.eventId, execFirst.eventId);
  assert.equal(execReplay.movementId, execFirst.movementId);
  assert.equal(await countAuditRows(db, tenantId, 'qc_event', execFirst.eventId), 1);

  await assert.rejects(
    createQcEvent(
      tenantId,
      {
        workOrderExecutionLineId: fixture.executionLineId,
        eventType: 'accept',
        quantity: 1,
        uom: 'each',
        actorType: 'system'
      },
      { idempotencyKey: `qc-exec-overcap:${randomUUID()}` }
    ),
    (error) => {
      assert.equal(error?.message, 'QC_EXCEEDS_EXECUTION');
      return true;
    }
  );

  await assert.rejects(
    createQcEvent(
      tenantId,
      {
        workOrderExecutionLineId: fixture.executionLineId,
        eventType: 'accept',
        quantity: 1,
        uom: 'kg',
        actorType: 'system'
      },
      { idempotencyKey: `qc-exec-uom:${randomUUID()}` }
    ),
    (error) => {
      assert.equal(error?.message, 'QC_UOM_MISMATCH');
      return true;
    }
  );

  await assert.rejects(
    createQcEvent(
      tenantId,
      {
        workOrderExecutionLineId: randomUUID(),
        eventType: 'accept',
        quantity: 1,
        uom: 'each',
        actorType: 'system'
      },
      { idempotencyKey: `qc-exec-missing:${randomUUID()}` }
    ),
    (error) => {
      assert.equal(error?.message, 'QC_EXECUTION_LINE_NOT_FOUND');
      return true;
    }
  );
});

test('warehouse disposition QC characterization preserves guards, transfer execution, audit rows, idempotent replay, and current no-key behavior', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-disposition',
    tenantName: 'Contract QC Disposition'
  });
  const { tenantId, pool: db, topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: `QC-DISP-${randomUUID().slice(0, 6)}`,
    type: 'finished'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.QA.id,
    quantity: 12,
    unitCost: 13
  });

  const acceptKey = `qc-disposition-accept:${randomUUID()}`;
  const acceptFirst = await harness.qcWarehouseDisposition(
    'accept',
    {
      warehouseId: topology.warehouse.id,
      itemId: item.id,
      quantity: 5,
      uom: 'each',
      idempotencyKey: acceptKey
    },
    { type: 'system', id: null },
    { idempotencyKey: acceptKey }
  );
  const acceptReplay = await harness.qcWarehouseDisposition(
    'accept',
    {
      warehouseId: topology.warehouse.id,
      itemId: item.id,
      quantity: 5,
      uom: 'each',
      idempotencyKey: acceptKey
    },
    { type: 'system', id: null },
    { idempotencyKey: acceptKey }
  );
  assert.equal(acceptFirst.replayed, false);
  assert.equal(acceptReplay.replayed, true);
  assert.equal(acceptReplay.movementId, acceptFirst.movementId);
  assert.equal(await countAuditRows(db, tenantId, 'qc_accept', acceptFirst.movementId), 1);

  const rejectKey = `qc-disposition-reject:${randomUUID()}`;
  const rejectFirst = await harness.qcWarehouseDisposition(
    'reject',
    {
      warehouseId: topology.warehouse.id,
      itemId: item.id,
      quantity: 4,
      uom: 'each',
      idempotencyKey: rejectKey
    },
    { type: 'system', id: null },
    { idempotencyKey: rejectKey }
  );
  assert.equal(rejectFirst.replayed, false);
  assert.equal(await countAuditRows(db, tenantId, 'qc_reject', rejectFirst.movementId), 1);

  assert.ok(Math.abs((await harness.readOnHand(item.id, topology.defaults.QA.id)) - 3) < 1e-6);
  assert.ok(Math.abs((await harness.readOnHand(item.id, topology.defaults.SELLABLE.id)) - 5) < 1e-6);
  assert.ok(Math.abs((await harness.readOnHand(item.id, topology.defaults.HOLD.id)) - 4) < 1e-6);

  const firstNoKey = await harness.qcWarehouseDisposition(
    'accept',
    {
      warehouseId: topology.warehouse.id,
      itemId: item.id,
      quantity: 1,
      uom: 'each'
    },
    { type: 'system', id: null }
  );
  const secondNoKey = await harness.qcWarehouseDisposition(
    'accept',
    {
      warehouseId: topology.warehouse.id,
      itemId: item.id,
      quantity: 1,
      uom: 'each'
    },
    { type: 'system', id: null }
  );
  assert.equal(firstNoKey.replayed, false);
  assert.equal(secondNoKey.replayed, false);
  assert.notEqual(firstNoKey.movementId, secondNoKey.movementId);

  const movementCountBeforeFailure = await harness.countInventoryMovementsBySourceType('qc_event');
  const auditCountBeforeFailure = (
    await db.query(`SELECT COUNT(*)::int AS count FROM audit_log WHERE tenant_id = $1`, [tenantId])
  ).rows[0].count;

  await assert.rejects(
    harness.qcWarehouseDisposition(
      'accept',
      {
        warehouseId: 'missing-warehouse',
        itemId: item.id,
        quantity: 1,
        uom: 'each'
      },
      { type: 'system', id: null }
    ),
    (error) => {
      assert.equal(error?.message, 'QC_WAREHOUSE_NOT_FOUND');
      return true;
    }
  );

  const qaMissing = await harness.createWarehouseWithSellable(`QC-NO-QA-${randomUUID().slice(0, 4)}`);
  await deleteWarehouseDefaultRole(db, tenantId, qaMissing.warehouse.id, 'QA');
  await assert.rejects(
    harness.qcWarehouseDisposition(
      'accept',
      {
        warehouseId: qaMissing.warehouse.id,
        itemId: item.id,
        quantity: 1,
        uom: 'each'
      },
      { type: 'system', id: null }
    ),
    (error) => {
      assert.equal(error?.message, 'QC_QA_LOCATION_REQUIRED');
      return true;
    }
  );

  const sellableMissing = await harness.createWarehouseWithSellable(`QC-NO-SELL-${randomUUID().slice(0, 4)}`);
  await deleteWarehouseDefaultRole(db, tenantId, sellableMissing.warehouse.id, 'SELLABLE');
  await assert.rejects(
    harness.qcWarehouseDisposition(
      'accept',
      {
        warehouseId: sellableMissing.warehouse.id,
        itemId: item.id,
        quantity: 1,
        uom: 'each'
      },
      { type: 'system', id: null }
    ),
    (error) => {
      assert.equal(error?.message, 'QC_ACCEPT_LOCATION_REQUIRED');
      return true;
    }
  );

  const holdMissing = await harness.createWarehouseWithSellable(`QC-NO-HOLD-${randomUUID().slice(0, 4)}`);
  await deleteWarehouseDefaultRole(db, tenantId, holdMissing.warehouse.id, 'HOLD');
  await assert.rejects(
    harness.qcWarehouseDisposition(
      'reject',
      {
        warehouseId: holdMissing.warehouse.id,
        itemId: item.id,
        quantity: 1,
        uom: 'each'
      },
      { type: 'system', id: null }
    ),
    (error) => {
      assert.equal(error?.message, 'QC_HOLD_LOCATION_REQUIRED');
      return true;
    }
  );

  const movementCountAfterFailure = await harness.countInventoryMovementsBySourceType('qc_event');
  const auditCountAfterFailure = (
    await db.query(`SELECT COUNT(*)::int AS count FROM audit_log WHERE tenant_id = $1`, [tenantId])
  ).rows[0].count;
  assert.equal(movementCountAfterFailure, movementCountBeforeFailure);
  assert.equal(Number(auditCountAfterFailure), Number(auditCountBeforeFailure));
});
