import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { buildMovementFixtureHash } from '../helpers/movementFixture.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { createQcEvent } = require('../../src/services/qc.service.ts');
const { closePurchaseOrderReceipt } = require('../../src/services/closeout.service.ts');
const { relocateTransferCostLayersInTx } = require('../../src/services/transferCosting.service.ts');
const {
  rebuildReceiptAllocations,
  validateOrRebuildReceiptAllocationsForMutation
} = require('../../src/domain/receipts/receiptAllocationRebuilder.ts');

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

async function loadMovementLines(db, tenantId, movementId) {
  const res = await db.query(
    `SELECT id,
            location_id AS "locationId",
            COALESCE(quantity_delta_canonical, quantity_delta)::numeric AS quantity,
            reason_code AS "reasonCode",
            line_notes AS "lineNotes"
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
      ORDER BY created_at ASC, id ASC`,
    [tenantId, movementId]
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

function normalizeAllocationsForRebuildComparison(allocations) {
  return allocations.map((allocation) => ({
    id: allocation.id,
    locationId: allocation.locationId,
    binId: allocation.binId,
    movementId: allocation.movementId,
    movementLineId: allocation.movementLineId,
    status: allocation.status,
    quantity: allocation.quantity
  }));
}

function normalizeAllocationsForStateComparison(allocations) {
  return allocations
    .map((allocation) => ({
      locationId: allocation.locationId,
      binId: allocation.binId,
      movementId: allocation.movementId,
      movementLineId: allocation.movementLineId,
      status: allocation.status,
      quantity: allocation.quantity
    }))
    .sort((left, right) => {
      const locationCompare = String(left.locationId).localeCompare(String(right.locationId));
      if (locationCompare !== 0) return locationCompare;
      const binCompare = String(left.binId).localeCompare(String(right.binId));
      if (binCompare !== 0) return binCompare;
      const statusCompare = String(left.status).localeCompare(String(right.status));
      if (statusCompare !== 0) return statusCompare;
      const movementCompare = String(left.movementId).localeCompare(String(right.movementId));
      if (movementCompare !== 0) return movementCompare;
      const movementLineCompare = String(left.movementLineId).localeCompare(String(right.movementLineId));
      if (movementLineCompare !== 0) return movementLineCompare;
      return Number(left.quantity) - Number(right.quantity);
    });
}

async function loadDefaultBinId(db, tenantId, locationId) {
  const res = await db.query(
    `SELECT id
       FROM inventory_bins
      WHERE tenant_id = $1
        AND location_id = $2
        AND is_default = true
      LIMIT 1`,
    [tenantId, locationId]
  );
  assert.equal(res.rowCount, 1);
  return res.rows[0].id;
}

async function createPostedDuplicateShapePutawayFixture(harness, options = {}) {
  const quantityPerLine = options.quantityPerLine ?? 2;
  const lineNumbers = options.lineNumbers ?? [1, 2];
  const inputOrder = options.inputOrder ?? [0, 1];
  const uom = options.uom ?? 'each';
  const missingNoteLineNumbers = new Set(options.missingNoteLineNumbers ?? []);
  const fixture = await createReceiptInQa(harness, {
    quantity: quantityPerLine * lineNumbers.length,
    uom
  });
  const initialAllocationResult = await harness.pool.query(
    `SELECT warehouse_id AS "warehouseId",
            cost_layer_id AS "costLayerId"
       FROM receipt_allocations
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = $2
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [harness.tenantId, fixture.receiptLineId]
  );
  assert.equal(initialAllocationResult.rowCount, 1);
  const destination = await harness.createWarehouseWithSellable(`PUT-${randomUUID().slice(0, 6)}`);
  const sourceBinId = await loadDefaultBinId(harness.pool, harness.tenantId, harness.topology.defaults.QA.id);
  const destinationBinId = await loadDefaultBinId(harness.pool, harness.tenantId, destination.sellable.id);
  const putawayId = randomUUID();
  const baseTime = new Date('2026-04-17T00:00:00.000Z');
  const movementLines = [];
  const positiveLineIdByLineNumber = new Map();
  const transferPairsByLineNumber = new Map();
  const putawayLineIdByLineNumber = new Map();
  for (const lineNumber of lineNumbers) {
    putawayLineIdByLineNumber.set(lineNumber, randomUUID());
  }
  for (const [offset, lineIndex] of inputOrder.entries()) {
    const lineNumber = lineNumbers[lineIndex];
    const putawayLineId = putawayLineIdByLineNumber.get(lineNumber);
    const lineNotes = missingNoteLineNumbers.has(lineNumber)
      ? `Putaway ${putawayId} line missing`
      : `Putaway ${putawayId} line ${lineNumber}`;
    const createdAt = new Date(baseTime.getTime() + offset);
    const outLineId = randomUUID();
    const inLineId = randomUUID();
    movementLines.push(
      {
        id: outLineId,
        sourceLineId: `${putawayLineId}#0`,
        itemId: fixture.item.id,
        locationId: harness.topology.defaults.QA.id,
        quantityDelta: -quantityPerLine,
        uom,
        quantityDeltaEntered: -quantityPerLine,
        uomEntered: uom,
        quantityDeltaCanonical: -quantityPerLine,
        canonicalUom: uom,
        uomDimension: 'count',
        reasonCode: 'putaway',
        lineNotes,
        createdAt
      },
      {
        id: inLineId,
        sourceLineId: `${putawayLineId}#1`,
        itemId: fixture.item.id,
        locationId: destination.sellable.id,
        quantityDelta: quantityPerLine,
        uom,
        quantityDeltaEntered: quantityPerLine,
        uomEntered: uom,
        quantityDeltaCanonical: quantityPerLine,
        canonicalUom: uom,
        uomDimension: 'count',
        reasonCode: 'putaway',
        lineNotes,
        createdAt
      }
    );
    positiveLineIdByLineNumber.set(lineNumber, inLineId);
    transferPairsByLineNumber.set(lineNumber, {
      itemId: fixture.item.id,
      sourceLocationId: harness.topology.defaults.QA.id,
      destinationLocationId: destination.sellable.id,
      outLineId,
      inLineId,
      quantity: quantityPerLine,
      uom
    });
  }
  const movementId = randomUUID();
  const movementHash = buildMovementFixtureHash({
    tenantId: harness.tenantId,
    movementType: 'transfer',
    occurredAt: baseTime,
    sourceType: 'putaway',
    sourceId: putawayId,
    lines: movementLines
  });
  await runInTransaction(harness.pool, async (client) => {
    await client.query(
      `INSERT INTO inventory_movements (
          id, tenant_id, movement_type, status, external_ref, source_type, source_id,
          idempotency_key, occurred_at, posted_at, notes, metadata,
          reversal_of_movement_id, reversed_by_movement_id, reversal_reason,
          movement_deterministic_hash, created_at, updated_at
       ) VALUES (
          $1, $2, 'transfer', 'posted', $3, 'putaway', $4,
          NULL, $5, $5, $6, NULL,
          NULL, NULL, NULL,
          $7, $5, $5
       )`,
      [
        movementId,
        harness.tenantId,
        `putaway:${putawayId}`,
        putawayId,
        baseTime,
        `Putaway ${putawayId}`,
        movementHash
      ]
    );
    for (const line of movementLines) {
      await client.query(
        `INSERT INTO inventory_movement_lines (
            id, tenant_id, movement_id, item_id, location_id,
            quantity_delta, uom, quantity_delta_entered, uom_entered,
            quantity_delta_canonical, canonical_uom, uom_dimension,
            unit_cost, extended_cost, reason_code, line_notes,
            source_line_id, event_timestamp, recorded_at, created_at
         ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, $12,
            NULL, NULL, $13, $14,
            $15, $16, $17, $18
         )`,
        [
          line.id,
          harness.tenantId,
          movementId,
          line.itemId,
          line.locationId,
          line.quantityDelta,
          line.uom,
          line.quantityDeltaEntered,
          line.uomEntered,
          line.quantityDeltaCanonical,
          line.canonicalUom,
          line.uomDimension,
          line.reasonCode,
          line.lineNotes,
          line.sourceLineId,
          line.createdAt,
          line.createdAt,
          line.createdAt
        ]
      );
    }
    await relocateTransferCostLayersInTx({
      client,
      tenantId: harness.tenantId,
      transferMovementId: movementId,
      occurredAt: baseTime,
      notes: `Putaway ${putawayId}`,
      pairs: lineNumbers.map((lineNumber) => transferPairsByLineNumber.get(lineNumber))
    });
    await client.query(
      `INSERT INTO putaways (
          id, tenant_id, status, source_type, purchase_order_receipt_id,
          inventory_movement_id, notes, created_at, updated_at, completed_at, putaway_number
       ) VALUES ($1, $2, 'completed', 'purchase_order_receipt', $3, $4, $5, $6, $6, $6, $7)`,
      [
        putawayId,
        harness.tenantId,
        fixture.receipt.id,
        movementId,
        `Putaway ${putawayId}`,
        baseTime,
        `P-FIX-${randomUUID().slice(0, 6)}`
      ]
    );
    for (const [offset, lineIndex] of inputOrder.entries()) {
      const lineNumber = lineNumbers[lineIndex];
      const putawayLineId = putawayLineIdByLineNumber.get(lineNumber);
      const lineTimestamp = new Date(baseTime.getTime() + offset);
      await client.query(
        `INSERT INTO putaway_lines (
            id, tenant_id, putaway_id, purchase_order_receipt_line_id, line_number,
            item_id, uom, quantity_planned, quantity_moved,
            from_location_id, from_bin_id, to_location_id, to_bin_id,
            inventory_movement_id, status, notes, created_at, updated_at
         ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $8,
            $9, $10, $11, $12,
            $13, 'completed', $14, $15, $15
         )`,
        [
          putawayLineId,
          harness.tenantId,
          putawayId,
          fixture.receiptLineId,
          lineNumber,
          fixture.item.id,
          uom,
          quantityPerLine,
          harness.topology.defaults.QA.id,
          sourceBinId,
          destination.sellable.id,
          destinationBinId,
          movementId,
          `Putaway fixture ${putawayId} line ${lineNumber}`,
          lineTimestamp
        ]
      );
    }
    await client.query(
      `DELETE FROM receipt_allocations
        WHERE tenant_id = $1
          AND purchase_order_receipt_line_id = $2`,
      [harness.tenantId, fixture.receiptLineId]
    );
    for (const lineNumber of lineNumbers) {
      await client.query(
        `INSERT INTO receipt_allocations (
            id, tenant_id, purchase_order_receipt_id, purchase_order_receipt_line_id,
            warehouse_id, location_id, bin_id, inventory_movement_id, inventory_movement_line_id,
            cost_layer_id, quantity, status, created_at, updated_at
         ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8, $9,
            $10, $11, 'AVAILABLE', $12, $12
         )`,
        [
          randomUUID(),
          harness.tenantId,
          fixture.receipt.id,
          fixture.receiptLineId,
          destination.warehouse.id,
          destination.sellable.id,
          destinationBinId,
          movementId,
          positiveLineIdByLineNumber.get(lineNumber),
          initialAllocationResult.rows[0].costLayerId,
          quantityPerLine,
          new Date(baseTime.getTime() + lineNumber)
        ]
      );
    }
  });
  return {
    ...fixture,
    destination,
    putaway: {
      id: putawayId,
      inventoryMovementId: movementId
    }
  };
}

async function runInTransaction(db, callback) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function duplicateMovementLine(db, tenantId, movementLineId) {
  const newId = randomUUID();
  await db.query(
    `INSERT INTO inventory_movement_lines (
        id,
        source_line_id,
        movement_id,
        item_id,
        location_id,
        quantity_delta,
        uom,
        reason_code,
        line_notes,
        created_at,
        tenant_id,
        unit_cost,
        extended_cost,
        quantity_delta_entered,
        uom_entered,
        quantity_delta_canonical,
        canonical_uom,
        uom_dimension
     )
     SELECT $1,
            $4,
            movement_id,
            item_id,
            location_id,
            quantity_delta,
            uom,
            reason_code,
            line_notes,
            created_at + interval '1 millisecond',
            tenant_id,
            unit_cost,
            extended_cost,
            quantity_delta_entered,
            uom_entered,
            quantity_delta_canonical,
            canonical_uom,
            uom_dimension
       FROM inventory_movement_lines
      WHERE tenant_id = $2
        AND id = $3`,
    [newId, tenantId, movementLineId, `syn:${newId}`]
  );
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

test('unresolved hold prevents QC completion — full hold', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-hold-blocks',
    tenantName: 'Contract QC Hold Blocks Completion'
  });
  const { tenantId, pool: db } = harness;

  const fixture = await createReceiptInQa(harness, { quantity: 5 });

  await createQcEvent(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      eventType: 'hold',
      quantity: 5,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `qc-hold-full:${randomUUID()}` }
  );

  const lifecycle = await loadReceiptLifecycle(db, tenantId, fixture.receipt.id);
  assert.equal(lifecycle?.lifecycle_state, 'QC_PENDING', 'QC must not complete while hold quantity is unresolved');
});

test('unresolved hold prevents QC completion — partial accept + partial hold', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-partial-hold',
    tenantName: 'Contract QC Partial Hold Blocks Completion'
  });
  const { tenantId, pool: db } = harness;

  const fixture = await createReceiptInQa(harness, { quantity: 6 });

  await createQcEvent(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      eventType: 'accept',
      quantity: 4,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `qc-partial-accept:${randomUUID()}` }
  );

  await createQcEvent(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      eventType: 'hold',
      quantity: 2,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `qc-partial-hold:${randomUUID()}` }
  );

  const lifecycle = await loadReceiptLifecycle(db, tenantId, fixture.receipt.id);
  assert.equal(lifecycle?.lifecycle_state, 'QC_PENDING', 'QC must not complete while hold quantity remains unresolved');
});

test('receipt QC rebuilds missing allocation state before mutating receipt allocations', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-allocation-rebuild',
    tenantName: 'Contract QC Allocation Rebuild'
  });
  const { tenantId, pool: db, topology } = harness;
  const fixture = await createReceiptInQa(harness, { quantity: 3 });

  await db.query(
    `DELETE FROM receipt_allocations
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = $2`,
    [tenantId, fixture.receiptLineId]
  );

  const result = await createQcEvent(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      eventType: 'accept',
      quantity: 2,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `qc-receipt-rebuild:${randomUUID()}` }
  );

  const allocations = await loadReceiptAllocations(db, tenantId, fixture.receiptLineId);
  assert.equal(result.replayed, false);
  assert.equal(allocations.length, 2);
  assert.equal(allocations.find((allocation) => allocation.status === 'AVAILABLE')?.locationId, topology.defaults.SELLABLE.id);
  assert.equal(allocations.reduce((total, allocation) => total + allocation.quantity, 0), 3);
});

test('receipt allocation rebuild is deterministic and idempotent', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-allocation-idempotent',
    tenantName: 'Contract QC Allocation Idempotent'
  });
  const { tenantId, pool: db } = harness;
  const fixture = await createReceiptInQa(harness, { quantity: 4 });

  await createQcEvent(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      eventType: 'accept',
      quantity: 2,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `qc-receipt-idempotent:${randomUUID()}` }
  );

  await runInTransaction(db, (client) =>
    rebuildReceiptAllocations({
      client,
      tenantId,
      receiptId: fixture.receipt.id,
      occurredAt: new Date()
    })
  );
  const first = normalizeAllocationsForRebuildComparison(
    await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)
  );
  await runInTransaction(db, (client) =>
    rebuildReceiptAllocations({
      client,
      tenantId,
      receiptId: fixture.receipt.id,
      occurredAt: new Date()
    })
  );
  const second = normalizeAllocationsForRebuildComparison(
    await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)
  );

  assert.deepEqual(second, first);
});

test('batched putaway with duplicate-shape positive movement lines rebuilds without ambiguity', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-putaway-duplicate-shape',
    tenantName: 'Contract Putaway Duplicate Shape'
  });
  const { tenantId, pool: db } = harness;
  const fixture = await createPostedDuplicateShapePutawayFixture(harness);

  const movementLines = await loadMovementLines(db, tenantId, fixture.putaway.inventoryMovementId);
  const positiveLines = movementLines.filter((line) => line.quantity > 0);
  assert.equal(positiveLines.length, 2);
  assert.equal(new Set(positiveLines.map((line) => line.locationId)).size, 1);
  assert.equal(new Set(positiveLines.map((line) => line.quantity)).size, 1);

  await db.query(
    `DELETE FROM receipt_allocations
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = $2`,
    [tenantId, fixture.receiptLineId]
  );

  await runInTransaction(db, (client) =>
    rebuildReceiptAllocations({
      client,
      tenantId,
      receiptId: fixture.receipt.id,
      occurredAt: new Date()
    })
  );

  const rebuilt = normalizeAllocationsForStateComparison(
    await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)
  );
  assert.equal(rebuilt.length, 2);
  assert.deepEqual(rebuilt.map((allocation) => allocation.quantity), [2, 2]);
  assert.ok(rebuilt.every((allocation) => allocation.status === 'AVAILABLE'));
});

test('receipt allocation rebuild preserves state after duplicate-shape batched putaway', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-putaway-rebuild-equivalence',
    tenantName: 'Contract Putaway Rebuild Equivalence'
  });
  const { tenantId, pool: db } = harness;
  const fixture = await createPostedDuplicateShapePutawayFixture(harness);

  const before = normalizeAllocationsForStateComparison(
    await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)
  );

  await db.query(
    `DELETE FROM receipt_allocations
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = $2`,
    [tenantId, fixture.receiptLineId]
  );

  await runInTransaction(db, (client) =>
    rebuildReceiptAllocations({
      client,
      tenantId,
      receiptId: fixture.receipt.id,
      occurredAt: new Date()
    })
  );

  const after = normalizeAllocationsForStateComparison(
    await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)
  );
  assert.deepEqual(after, before);
});

test('receipt allocation rebuild remains deterministic for duplicate-shape putaway under varied input ordering', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-putaway-input-order',
    tenantName: 'Contract Putaway Input Order'
  });
  const { tenantId, pool: db } = harness;
  const fixture = await createPostedDuplicateShapePutawayFixture(harness, {
    lineNumbers: [2, 1],
    inputOrder: [0, 1]
  });

  await db.query(
    `DELETE FROM receipt_allocations
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = $2`,
    [tenantId, fixture.receiptLineId]
  );
  await runInTransaction(db, (client) =>
    rebuildReceiptAllocations({
      client,
      tenantId,
      receiptId: fixture.receipt.id,
      occurredAt: new Date('2026-04-17T00:00:00.000Z')
    })
  );
  const first = normalizeAllocationsForRebuildComparison(
    await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)
  );

  await db.query(
    `DELETE FROM receipt_allocations
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = $2`,
    [tenantId, fixture.receiptLineId]
  );
  await runInTransaction(db, (client) =>
    rebuildReceiptAllocations({
      client,
      tenantId,
      receiptId: fixture.receipt.id,
      occurredAt: new Date('2026-04-17T00:00:00.000Z')
    })
  );
  const second = normalizeAllocationsForRebuildComparison(
    await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)
  );

  assert.deepEqual(second, first);
});

test('receipt allocation rebuild fails explicitly when putaway note discriminator is missing', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-putaway-note-contract',
    tenantName: 'Contract Putaway Note Contract'
  });
  const { tenantId, pool: db } = harness;
  const fixture = await createPostedDuplicateShapePutawayFixture(harness, {
    missingNoteLineNumbers: [1]
  });

  await db.query(
    `DELETE FROM receipt_allocations
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = $2`,
    [tenantId, fixture.receiptLineId]
  );

  await assert.rejects(
    runInTransaction(db, (client) =>
      rebuildReceiptAllocations({
        client,
        tenantId,
        receiptId: fixture.receipt.id,
        occurredAt: new Date()
      })
    ),
    /RECEIPT_AUTHORITATIVE_DATA_INCONSISTENT:movement_line_note_unmatched/
  );
  assert.equal((await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)).length, 0);
});

test('receipt allocation rebuild preserves complex lifecycle state after partial QC and reconciliation adjustment', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-allocation-lifecycle',
    tenantName: 'Contract QC Allocation Lifecycle'
  });
  const { tenantId, pool: db, topology } = harness;
  const fixture = await createReceiptInQa(harness, { quantity: 6 });
  const sellableBinId = await loadDefaultBinId(db, tenantId, topology.defaults.SELLABLE.id);

  await createQcEvent(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      eventType: 'accept',
      quantity: 2,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `qc-receipt-lifecycle-accept-1:${randomUUID()}` }
  );
  await createQcEvent(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      eventType: 'accept',
      quantity: 4,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `qc-receipt-lifecycle-accept-2:${randomUUID()}` }
  );

  const closeout = await closePurchaseOrderReceipt(tenantId, fixture.receipt.id, {
    actorType: 'system',
    notes: 'partial QC lifecycle equivalence adjustment',
    physicalCounts: [
      {
        purchaseOrderReceiptLineId: fixture.receiptLineId,
        locationId: topology.defaults.SELLABLE.id,
        binId: sellableBinId,
        allocationStatus: 'AVAILABLE',
        countedQty: 5,
        toleranceQty: 0
      }
    ],
    resolution: {
      mode: 'adjustment',
      notes: 'adjust after partial QC lifecycle'
    }
  });

  assert.equal(closeout.receipt.status, 'closed');
  const beforeRebuild = normalizeAllocationsForStateComparison(
    await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)
  );

  await db.query(
    `DELETE FROM receipt_allocations
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = $2`,
    [tenantId, fixture.receiptLineId]
  );

  await runInTransaction(db, (client) =>
    rebuildReceiptAllocations({
      client,
      tenantId,
      receiptId: fixture.receipt.id,
      occurredAt: new Date()
    })
  );

  const afterRebuild = normalizeAllocationsForStateComparison(
    await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)
  );

  assert.deepEqual(afterRebuild, beforeRebuild);
});

test('receipt allocation rebuild fails when authoritative movement link is unmatched', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-allocation-unmatched',
    tenantName: 'Contract QC Allocation Unmatched'
  });
  const { tenantId, pool: db } = harness;
  const fixture = await createReceiptInQa(harness, { quantity: 3 });

  const result = await createQcEvent(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      eventType: 'accept',
      quantity: 1,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `qc-receipt-unmatched:${randomUUID()}` }
  );
  await db.query(
    `DELETE FROM qc_inventory_links
      WHERE tenant_id = $1
        AND inventory_movement_id = $2`,
    [tenantId, result.movementId]
  );

  await assert.rejects(
    runInTransaction(db, (client) =>
      rebuildReceiptAllocations({
        client,
        tenantId,
        receiptId: fixture.receipt.id,
        occurredAt: new Date()
      })
    ),
    /RECEIPT_AUTHORITATIVE_DATA_INCONSISTENT:qc_movement_missing/
  );
});

test('receipt allocation rebuild fails on authoritative movement ambiguity', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-allocation-ambiguous',
    tenantName: 'Contract QC Allocation Ambiguous'
  });
  const { tenantId, pool: db } = harness;
  const fixture = await createReceiptInQa(harness, { quantity: 2 });
  const [initialAllocation] = await loadReceiptAllocations(db, tenantId, fixture.receiptLineId);

  await duplicateMovementLine(db, tenantId, initialAllocation.movementLineId);
  await db.query(
    `DELETE FROM receipt_allocations
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = $2`,
    [tenantId, fixture.receiptLineId]
  );

  await assert.rejects(
    runInTransaction(db, (client) =>
      rebuildReceiptAllocations({
        client,
        tenantId,
        receiptId: fixture.receipt.id,
        occurredAt: new Date()
      })
    ),
    /RECEIPT_AUTHORITATIVE_DATA_INCONSISTENT:movement_line_note_unmatched/
  );
  assert.equal((await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)).length, 0);
});

test('receipt allocation validation rejects orphaned receipt linkage before mutation', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-allocation-orphan',
    tenantName: 'Contract QC Allocation Orphan'
  });
  const { tenantId, pool: db } = harness;
  const fixture = await createReceiptInQa(harness, { quantity: 3 });
  const otherFixture = await createReceiptInQa(harness, { quantity: 1 });

  await db.query(
    `UPDATE receipt_allocations
        SET purchase_order_receipt_id = $3
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = $2`,
    [tenantId, fixture.receiptLineId, otherFixture.receipt.id]
  );

  await assert.rejects(
    runInTransaction(db, (client) =>
      validateOrRebuildReceiptAllocationsForMutation({
        client,
        tenantId,
        receiptId: fixture.receipt.id,
        occurredAt: new Date(),
        requirements: [{ receiptLineId: fixture.receiptLineId }]
      })
    ),
    /RECEIPT_ALLOCATION_ORPHANED/
  );
});

test('receipt closeout adjustment uses adjustment-aware allocation expectations', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-receipt-closeout-adjustment',
    tenantName: 'Contract Receipt Closeout Adjustment'
  });
  const { tenantId, pool: db, topology } = harness;
  const fixture = await createReceiptInQa(harness, { quantity: 5 });
  const sellableBinId = await loadDefaultBinId(db, tenantId, topology.defaults.SELLABLE.id);

  await createQcEvent(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      eventType: 'accept',
      quantity: 5,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `qc-receipt-closeout-adjustment:${randomUUID()}` }
  );

  await db.query(
    `DELETE FROM receipt_allocations
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = $2`,
    [tenantId, fixture.receiptLineId]
  );

  const reconciliation = await closePurchaseOrderReceipt(tenantId, fixture.receipt.id, {
    actorType: 'system',
    notes: 'adjust closeout mismatch',
    physicalCounts: [
      {
        purchaseOrderReceiptLineId: fixture.receiptLineId,
        locationId: topology.defaults.SELLABLE.id,
        binId: sellableBinId,
        allocationStatus: 'AVAILABLE',
        countedQty: 3,
        toleranceQty: 0
      }
    ],
    resolution: {
      mode: 'adjustment',
      notes: 'adjust to counted quantity'
    }
  });

  assert.equal(reconciliation.receipt.status, 'closed');
  assert.equal(reconciliation.lines[0].quantityReceived, 5);
  assert.equal(reconciliation.lines[0].allocationExpectedQuantity, 3);
  assert.equal(reconciliation.lines[0].allocationSummary.total, 3);
  assert.equal(reconciliation.lines[0].blockedReasons.includes('Receipt allocation total does not match received quantity'), false);

  const beforeRebuild = normalizeAllocationsForStateComparison(
    await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)
  );
  await db.query(
    `DELETE FROM receipt_allocations
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = $2`,
    [tenantId, fixture.receiptLineId]
  );
  await runInTransaction(db, (client) =>
    rebuildReceiptAllocations({
      client,
      tenantId,
      receiptId: fixture.receipt.id,
      occurredAt: new Date()
    })
  );
  const afterRebuild = normalizeAllocationsForStateComparison(
    await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)
  );

  assert.deepEqual(afterRebuild, beforeRebuild);
});

test('receipt allocation rebuild fails explicitly under concurrent authoritative locks without partial state', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-allocation-concurrency',
    tenantName: 'Contract QC Allocation Concurrency'
  });
  const { tenantId, pool: db } = harness;
  const fixture = await createReceiptInQa(harness, { quantity: 4 });
  const before = normalizeAllocationsForRebuildComparison(
    await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)
  );
  const beforeState = normalizeAllocationsForStateComparison(
    await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)
  );

  const lockClient = await db.connect();
  const rebuildClient = await db.connect();
  try {
    await lockClient.query('BEGIN');
    await lockClient.query(
      `SELECT id
         FROM purchase_order_receipt_lines
        WHERE tenant_id = $1
          AND id = $2
        FOR UPDATE`,
      [tenantId, fixture.receiptLineId]
    );

    await rebuildClient.query('BEGIN');
    await rebuildClient.query("SET LOCAL lock_timeout TO '50ms'");
    await assert.rejects(
      rebuildReceiptAllocations({
        client: rebuildClient,
        tenantId,
        receiptId: fixture.receipt.id,
        occurredAt: new Date()
      }),
      (error) => {
        assert.equal(error?.message, 'RECEIPT_ALLOCATION_REBUILD_CONCURRENT_MODIFICATION');
        assert.equal(error?.code, 'RECEIPT_ALLOCATION_REBUILD_CONCURRENT_MODIFICATION');
        return true;
      }
    );
    await rebuildClient.query('ROLLBACK');
  } finally {
    await lockClient.query('ROLLBACK').catch(() => undefined);
    lockClient.release();
    rebuildClient.release();
  }

  const afterFailure = normalizeAllocationsForRebuildComparison(
    await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)
  );
  assert.deepEqual(afterFailure, before);

  await runInTransaction(db, (client) =>
    rebuildReceiptAllocations({
      client,
      tenantId,
      receiptId: fixture.receipt.id,
      occurredAt: new Date()
    })
  );

  assert.deepEqual(
    normalizeAllocationsForStateComparison(await loadReceiptAllocations(db, tenantId, fixture.receiptLineId)),
    beforeState
  );
});

test('receipt QC aborts without authoritative side effects when allocation rebuild cannot validate', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-allocation-unrecoverable',
    tenantName: 'Contract QC Allocation Unrecoverable'
  });
  const { tenantId, pool: db } = harness;
  const fixture = await createReceiptInQa(harness, { quantity: 3 });

  await db.query(
    `DELETE FROM receipt_allocations
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = $2`,
    [tenantId, fixture.receiptLineId]
  );
  await db.query(
    `UPDATE purchase_order_receipt_lines
        SET quantity_received = 99
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, fixture.receiptLineId]
  );

  await assert.rejects(
    createQcEvent(
      tenantId,
      {
        purchaseOrderReceiptLineId: fixture.receiptLineId,
        eventType: 'accept',
        quantity: 1,
        uom: 'each',
        actorType: 'system'
      },
      { idempotencyKey: `qc-receipt-unrecoverable:${randomUUID()}` }
    ),
    /RECEIPT_AUTHORITATIVE_DATA_INCONSISTENT/
  );
  assert.equal(await countQcEventsForSource(db, tenantId, 'purchase_order_receipt_line_id', fixture.receiptLineId), 0);
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

test('warehouse disposition transfer and audit log are co-committed within the same explicit transaction boundary', { timeout: 120000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-atomic',
    tenantName: 'Contract QC Atomicity'
  });
  const { tenantId, pool: db, topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: `QC-ATOM-${randomUUID().slice(0, 6)}`,
    type: 'finished'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.QA.id,
    quantity: 4,
    unitCost: 8
  });

  const atomKey = `qc-atom:${randomUUID()}`;
  const first = await harness.qcWarehouseDisposition(
    'accept',
    {
      warehouseId: topology.warehouse.id,
      itemId: item.id,
      quantity: 2,
      uom: 'each',
      idempotencyKey: atomKey
    },
    { type: 'system', id: null },
    { idempotencyKey: atomKey }
  );
  assert.equal(first.replayed, false);

  // Both movement and audit row must exist after the first commit — proves
  // they were written within the same withInventoryTransaction boundary.
  const movementRow = await db.query(
    `SELECT id FROM inventory_movements WHERE tenant_id = $1 AND id = $2`,
    [tenantId, first.movementId]
  );
  assert.equal(movementRow.rowCount, 1, 'movement must exist after committed disposition');

  const auditRow = await db.query(
    `SELECT id FROM audit_log WHERE tenant_id = $1 AND entity_type = 'qc_accept' AND entity_id = $2`,
    [tenantId, first.movementId]
  );
  assert.equal(auditRow.rowCount, 1, 'audit row must co-exist with movement in same committed transaction');

  // Replay must not create a second audit row — proves the !t.replayed guard works.
  const replay = await harness.qcWarehouseDisposition(
    'accept',
    {
      warehouseId: topology.warehouse.id,
      itemId: item.id,
      quantity: 2,
      uom: 'each',
      idempotencyKey: atomKey
    },
    { type: 'system', id: null },
    { idempotencyKey: atomKey }
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.movementId, first.movementId);

  const auditCountAfterReplay = await countAuditRows(db, tenantId, 'qc_accept', first.movementId);
  assert.equal(auditCountAfterReplay, 1, 'replay must not insert a second audit row');
});

// ──────────────────────────────────────────────────────────────────────────────
// WP3: Hold Disposition Tests
// ──────────────────────────────────────────────────────────────────────────────

const { resolveHoldDisposition } = require('../../src/services/holdDisposition.service.ts');

async function loadHoldDispositionEvents(db, tenantId, receiptLineId) {
  const res = await db.query(
    `SELECT id, disposition_type, quantity::numeric AS quantity, uom,
            inventory_movement_id AS "movementId"
       FROM hold_disposition_events
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = $2
      ORDER BY created_at ASC, id ASC`,
    [tenantId, receiptLineId]
  );
  return res.rows.map((row) => ({ ...row, quantity: Number(row.quantity) }));
}

async function createHoldFixture(harness, { quantity = 10 } = {}) {
  const fixture = await createReceiptInQa(harness, { quantity });
  await createQcEvent(
    harness.tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      eventType: 'hold',
      quantity,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `qc-hold-fixture:${randomUUID()}` }
  );
  return fixture;
}

test('hold disposition response shape includes warehouse ids', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp3-hold-response-shape',
    tenantName: 'WP3 Hold Response Shape'
  });
  const { tenantId, topology } = harness;

  const fixture = await createHoldFixture(harness, { quantity: 10 });

  const result = await resolveHoldDisposition(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      dispositionType: 'release',
      quantity: 10,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `wp3-hold-response-shape:${randomUUID()}` }
  );

  assert.equal(result.sourceLocationId, topology.defaults.HOLD.id);
  assert.equal(result.destinationLocationId, topology.defaults.SELLABLE.id);
  assert.equal(result.sourceWarehouseId, topology.warehouse.id);
  assert.equal(result.destinationWarehouseId, topology.warehouse.id);
});

test('hold → release: held quantity becomes available, QC completes', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp3-hold-release',
    tenantName: 'WP3 Hold Release'
  });
  const { tenantId, pool: db, topology } = harness;

  const fixture = await createHoldFixture(harness, { quantity: 10 });

  const lifecycleBefore = await loadReceiptLifecycle(db, tenantId, fixture.receipt.id);
  assert.equal(lifecycleBefore?.lifecycle_state, 'QC_PENDING', 'QC must be pending while hold is unresolved');

  const allocationsBefore = await loadReceiptAllocations(db, tenantId, fixture.receiptLineId);
  assert.equal(allocationsBefore.length, 1);
  assert.equal(allocationsBefore[0].status, 'HOLD');

  const result = await resolveHoldDisposition(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      dispositionType: 'release',
      quantity: 10,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `wp3-release:${randomUUID()}` }
  );

  assert.equal(result.replayed, false);
  assert.ok(result.movementId, 'movement must be created');
  assert.equal(result.dispositionType, 'release');
  assert.ok(Math.abs(result.quantity - 10) < 1e-6);

  const allocationsAfter = await loadReceiptAllocations(db, tenantId, fixture.receiptLineId);
  assert.equal(allocationsAfter.length, 1, 'one allocation must exist after release');
  assert.equal(allocationsAfter[0].status, 'AVAILABLE', 'allocation must become AVAILABLE');
  assert.equal(allocationsAfter[0].locationId, topology.defaults.SELLABLE.id, 'allocation must be at SELLABLE location');
  assert.ok(Math.abs(allocationsAfter[0].quantity - 10) < 1e-6, 'full quantity must be available');

  const dispositions = await loadHoldDispositionEvents(db, tenantId, fixture.receiptLineId);
  assert.equal(dispositions.length, 1, 'one disposition event must be recorded');
  assert.equal(dispositions[0].disposition_type, 'release');
  assert.ok(Math.abs(dispositions[0].quantity - 10) < 1e-6);

  const lifecycleAfter = await loadReceiptLifecycle(db, tenantId, fixture.receipt.id);
  assert.equal(lifecycleAfter?.lifecycle_state, 'QC_COMPLETED', 'QC must complete after hold is released');

  const auditCount = await countAuditRows(db, tenantId, 'hold_disposition_event', result.eventId);
  assert.equal(auditCount, 1, 'audit log must be written');
});

test('hold → discard: quantity permanently removed, QC completes', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp3-hold-discard',
    tenantName: 'WP3 Hold Discard'
  });
  const { tenantId, pool: db } = harness;

  const fixture = await createHoldFixture(harness, { quantity: 8 });

  const result = await resolveHoldDisposition(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      dispositionType: 'discard',
      quantity: 8,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `wp3-discard:${randomUUID()}` }
  );

  assert.equal(result.dispositionType, 'discard');
  assert.ok(result.movementId, 'movement must be created for discard');

  const allocationsAfter = await loadReceiptAllocations(db, tenantId, fixture.receiptLineId);
  assert.equal(allocationsAfter.length, 1, 'one terminal allocation must remain');
  assert.equal(allocationsAfter[0].status, 'DISCARDED', 'allocation must be DISCARDED');
  assert.ok(Math.abs(allocationsAfter[0].quantity - 8) < 1e-6, 'quantity must be conserved in terminal status');

  const lifecycleAfter = await loadReceiptLifecycle(db, tenantId, fixture.receipt.id);
  assert.equal(lifecycleAfter?.lifecycle_state, 'REJECTED', 'QC must complete with REJECTED state when all units are discarded (no accepted quantity)');
});

test('hold → rework: quantity exits normal flow, QC completes', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp3-hold-rework',
    tenantName: 'WP3 Hold Rework'
  });
  const { tenantId, pool: db } = harness;

  const fixture = await createHoldFixture(harness, { quantity: 6 });

  const result = await resolveHoldDisposition(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      dispositionType: 'rework',
      quantity: 6,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `wp3-rework:${randomUUID()}` }
  );

  assert.equal(result.dispositionType, 'rework');

  const allocationsAfter = await loadReceiptAllocations(db, tenantId, fixture.receiptLineId);
  assert.equal(allocationsAfter.length, 1, 'one terminal allocation must remain');
  assert.equal(allocationsAfter[0].status, 'REWORK', 'allocation must be REWORK');
  assert.ok(Math.abs(allocationsAfter[0].quantity - 6) < 1e-6);

  const lifecycleAfter = await loadReceiptLifecycle(db, tenantId, fixture.receipt.id);
  // Rework is not permanent rejection — items leave normal flow for remake/reuse.
  // QC_COMPLETED is correct; REJECTED is reserved for fully discarded/rejected receipts.
  assert.equal(lifecycleAfter?.lifecycle_state, 'QC_COMPLETED', 'QC must complete when all units are reworked (rework is not permanent rejection)');
});

test('partial: accept 90, hold 10, release 10 → QC completes, accepted qty unaffected', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp3-partial-release',
    tenantName: 'WP3 Partial Release'
  });
  const { tenantId, pool: db, topology } = harness;

  const fixture = await createReceiptInQa(harness, { quantity: 100 });

  await createQcEvent(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      eventType: 'accept',
      quantity: 90,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `wp3-accept-90:${randomUUID()}` }
  );

  await createQcEvent(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      eventType: 'hold',
      quantity: 10,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `wp3-hold-10:${randomUUID()}` }
  );

  const midLifecycle = await loadReceiptLifecycle(db, tenantId, fixture.receipt.id);
  assert.equal(midLifecycle?.lifecycle_state, 'QC_PENDING', 'QC must still be pending with 10 on hold');

  await resolveHoldDisposition(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      dispositionType: 'release',
      quantity: 10,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `wp3-release-10:${randomUUID()}` }
  );

  const finalLifecycle = await loadReceiptLifecycle(db, tenantId, fixture.receipt.id);
  assert.equal(finalLifecycle?.lifecycle_state, 'QC_COMPLETED', 'QC must complete after releasing held 10');

  const allocations = await loadReceiptAllocations(db, tenantId, fixture.receiptLineId);
  const availableAllocations = allocations.filter((a) => a.status === 'AVAILABLE');
  const holdAllocations = allocations.filter((a) => a.status === 'HOLD');

  assert.equal(holdAllocations.length, 0, 'no HOLD allocations must remain');
  const totalAvailable = availableAllocations.reduce((sum, a) => sum + a.quantity, 0);
  assert.ok(Math.abs(totalAvailable - 100) < 1e-6, 'all 100 units must be AVAILABLE');

  // All allocations at SELLABLE location
  for (const alloc of availableAllocations) {
    assert.equal(alloc.locationId, topology.defaults.SELLABLE.id, 'released hold must be at SELLABLE location');
  }
});

test('hold disposition: cannot dispose more than held quantity', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp3-over-dispose',
    tenantName: 'WP3 Over-Disposition Guard'
  });
  const { tenantId } = harness;

  const fixture = await createHoldFixture(harness, { quantity: 5 });

  await assert.rejects(
    resolveHoldDisposition(
      tenantId,
      {
        purchaseOrderReceiptLineId: fixture.receiptLineId,
        dispositionType: 'release',
        quantity: 6,
        uom: 'each',
        actorType: 'system'
      },
      { idempotencyKey: `wp3-over-dispose:${randomUUID()}` }
    ),
    (error) => {
      assert.equal(error?.message, 'HOLD_DISPOSITION_EXCEEDS_HELD');
      return true;
    }
  );
});

test('hold disposition: cannot re-resolve already fully disposed quantity', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp3-redispose',
    tenantName: 'WP3 Re-Disposition Guard'
  });
  const { tenantId } = harness;

  const fixture = await createHoldFixture(harness, { quantity: 5 });

  await resolveHoldDisposition(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      dispositionType: 'discard',
      quantity: 5,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `wp3-first-dispose:${randomUUID()}` }
  );

  await assert.rejects(
    resolveHoldDisposition(
      tenantId,
      {
        purchaseOrderReceiptLineId: fixture.receiptLineId,
        dispositionType: 'release',
        quantity: 1,
        uom: 'each',
        actorType: 'system'
      },
      { idempotencyKey: `wp3-re-dispose:${randomUUID()}` }
    ),
    (error) => {
      assert.ok(
        error?.message === 'HOLD_DISPOSITION_EXCEEDS_HELD' || error?.message === 'HOLD_DISPOSITION_NO_HELD_QUANTITY',
        `expected over-disposition error but got: ${error?.message}`
      );
      return true;
    }
  );
});

test('hold disposition: accepted quantity is not affected by hold resolution', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wp3-accepted-safe',
    tenantName: 'WP3 Accepted Qty Unaffected'
  });
  const { tenantId, pool: db, topology } = harness;

  const fixture = await createReceiptInQa(harness, { quantity: 20 });

  await createQcEvent(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      eventType: 'accept',
      quantity: 15,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `wp3-accepted-15:${randomUUID()}` }
  );

  await createQcEvent(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      eventType: 'hold',
      quantity: 5,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `wp3-held-5:${randomUUID()}` }
  );

  const allocsBefore = await loadReceiptAllocations(db, tenantId, fixture.receiptLineId);
  const availBefore = allocsBefore.filter((a) => a.status === 'AVAILABLE');
  const totalAvailBefore = availBefore.reduce((sum, a) => sum + a.quantity, 0);
  assert.ok(Math.abs(totalAvailBefore - 15) < 1e-6, 'accepted 15 must be AVAILABLE before disposition');

  await resolveHoldDisposition(
    tenantId,
    {
      purchaseOrderReceiptLineId: fixture.receiptLineId,
      dispositionType: 'rework',
      quantity: 5,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `wp3-rework-5:${randomUUID()}` }
  );

  const allocsAfter = await loadReceiptAllocations(db, tenantId, fixture.receiptLineId);
  const availAfter = allocsAfter.filter((a) => a.status === 'AVAILABLE');
  const totalAvailAfter = availAfter.reduce((sum, a) => sum + a.quantity, 0);
  assert.ok(Math.abs(totalAvailAfter - 15) < 1e-6, 'accepted 15 must still be AVAILABLE and unaffected by rework');

  const reworkAllocs = allocsAfter.filter((a) => a.status === 'REWORK');
  assert.equal(reworkAllocs.length, 1, 'one REWORK terminal allocation must exist');
  assert.ok(Math.abs(reworkAllocs[0].quantity - 5) < 1e-6);

  const lifecycle = await loadReceiptLifecycle(db, tenantId, fixture.receipt.id);
  assert.equal(lifecycle?.lifecycle_state, 'QC_COMPLETED', 'QC must complete');
});
