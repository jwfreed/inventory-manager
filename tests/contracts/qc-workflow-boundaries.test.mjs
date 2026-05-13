import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { buildMovementFixtureHash, insertPostedMovementFixture } from '../helpers/movementFixture.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { createQcEvent } = require('../../src/services/qc.service.ts');
const { closePurchaseOrderReceipt } = require('../../src/services/closeout.service.ts');
const { fetchReceiptById } = require('../../src/services/receipts.service.ts');
const { createPutaway, postPutaway } = require('../../src/services/putaways.service.ts');
const {
  buildPutawayPostedEventPayload,
  mapPutawayTransferInvariantError
} = require('../../src/routes/putaways.routes.ts');
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

async function createMultiLineReceiptInQa(harness, lines) {
  const vendor = await harness.createVendor('QC-MULTI');
  const items = [];
  for (const [index, line] of lines.entries()) {
    items.push(
      await harness.createItem({
        defaultLocationId: harness.topology.defaults.SELLABLE.id,
        skuPrefix: `QC-MULTI-${index}-${randomUUID().slice(0, 6)}`,
        type: line.type ?? 'raw',
        defaultUom: line.uom,
        uomDimension: line.uomDimension,
        canonicalUom: line.canonicalUom,
        stockingUom: line.uom
      })
    );
  }
  const purchaseOrder = await harness.createPurchaseOrder({
    vendorId: vendor.id,
    shipToLocationId: harness.topology.defaults.QA.id,
    receivingLocationId: harness.topology.defaults.QA.id,
    expectedDate: '2026-01-10',
    status: 'approved',
    lines: lines.map((line, index) => ({
      itemId: items[index].id,
      uom: line.uom,
      quantityOrdered: line.quantity,
      unitCost: line.unitCost ?? 5,
      currencyCode: 'THB'
    }))
  });
  const posted = await harness.postReceipt({
    purchaseOrderId: purchaseOrder.id,
    receivedAt: '2026-01-11T00:00:00.000Z',
    idempotencyKey: `receipt:${harness.tenantId}:${randomUUID()}`,
    lines: purchaseOrder.lines.map((poLine, index) => ({
      purchaseOrderLineId: poLine.id,
      uom: lines[index].uom,
      quantityReceived: lines[index].quantity,
      unitCost: lines[index].unitCost ?? 5
    }))
  });
  return {
    items,
    receipt: posted.receipt,
    lines: posted.receipt.lines
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

async function loadPutawayMovementSummaries(db, tenantId, putawayId) {
  const res = await db.query(
    `SELECT pl.inventory_movement_id AS "movementId",
            COUNT(DISTINCT pl.id)::int AS "putawayLineCount",
            COUNT(DISTINCT COALESCE(iml.canonical_uom, iml.uom))::int AS "uomCount",
            ARRAY_AGG(DISTINCT COALESCE(iml.canonical_uom, iml.uom) ORDER BY COALESCE(iml.canonical_uom, iml.uom)) AS uoms,
            COALESCE(SUM(COALESCE(iml.quantity_delta_canonical, iml.quantity_delta)), 0)::numeric AS "netQty",
            COUNT(DISTINCT iml.id)::int AS "movementLineCount"
       FROM putaway_lines pl
       JOIN inventory_movement_lines iml
         ON iml.tenant_id = pl.tenant_id
        AND iml.movement_id = pl.inventory_movement_id
      WHERE pl.tenant_id = $1
        AND pl.putaway_id = $2
        AND pl.status <> 'canceled'
      GROUP BY pl.inventory_movement_id
      ORDER BY MIN(pl.line_number) ASC`,
    [tenantId, putawayId]
  );
  return res.rows.map((row) => ({
    ...row,
    netQty: Number(row.netQty)
  }));
}

async function loadMovementCountForPutaway(db, tenantId, putawayId) {
  const res = await db.query(
    `SELECT COUNT(DISTINCT inventory_movement_id)::int AS count
       FROM putaway_lines
      WHERE tenant_id = $1
        AND putaway_id = $2
        AND inventory_movement_id IS NOT NULL`,
    [tenantId, putawayId]
  );
  return Number(res.rows[0]?.count ?? 0);
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

async function createDraftPutawayForReceiptLine(harness, fixture, { quantity, uom = 'each', toLocationId } = {}) {
  return createPutaway(
    harness.tenantId,
    {
      sourceType: 'purchase_order_receipt',
      purchaseOrderReceiptId: fixture.receipt.id,
      lines: [
        {
          purchaseOrderReceiptLineId: fixture.receiptLineId,
          toLocationId: toLocationId ?? harness.topology.defaults.SELLABLE.id,
          uom,
          quantity
        }
      ]
    },
    { type: 'system', id: null },
    { idempotencyKey: `putaway:${fixture.receiptLineId}:${quantity}:${randomUUID()}` }
  );
}

async function postPutawayForReceiptLine(harness, fixture, { quantity, uom = 'each', toLocationId } = {}) {
  const putaway = await createDraftPutawayForReceiptLine(harness, fixture, { quantity, uom, toLocationId });
  return postPutaway(harness.tenantId, putaway.id, {
    actor: { type: 'system', id: null }
  });
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
    await insertPostedMovementFixture(client, {
      id: movementId,
      tenantId: harness.tenantId,
      movementType: 'transfer',
      sourceType: 'putaway',
      sourceId: putawayId,
      externalRef: `putaway:${putawayId}`,
      occurredAt: baseTime,
      postedAt: baseTime,
      createdAt: baseTime,
      notes: `Putaway ${putawayId}`,
      movementDeterministicHash: movementHash,
      lines: movementLines
    });
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

test('receipt QC characterization keeps accepted stock in QA for putaway, preserves lifecycle transitions, NCR creation, and replay', { timeout: 240000 }, async () => {
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
  assert.equal(acceptedFirst.movementId, null, 'receipt QC accept must not post sellable inventory movement');
  assert.equal(
    await countQcEventsForSource(db, tenantId, 'purchase_order_receipt_line_id', accepted.receiptLineId),
    1
  );
  assert.equal(await countAuditRows(db, tenantId, 'qc_event', acceptedFirst.eventId), 1);

  const acceptedAllocations = await loadReceiptAllocations(db, tenantId, accepted.receiptLineId);
  assert.equal(acceptedAllocations.length, 1);
  assert.equal(acceptedAllocations[0].status, 'QA');
  assert.equal(acceptedAllocations[0].locationId, topology.defaults.QA.id);
  assert.equal(acceptedAllocations[0].movementId, initialAllocations[0].movementId);
  assert.ok(Math.abs(acceptedAllocations[0].quantity - 5) < 1e-6);

  assert.equal(await harness.readOnHand(accepted.item.id, topology.defaults.QA.id), 5);
  assert.equal(await harness.readOnHand(accepted.item.id, topology.defaults.SELLABLE.id), 0);

  const acceptedReceiptView = await fetchReceiptById(tenantId, accepted.receipt.id);
  const acceptedLineView = acceptedReceiptView?.lines.find((line) => line.id === accepted.receiptLineId);
  assert.ok(acceptedLineView, 'accepted receipt line appears in read model');
  assert.equal(acceptedLineView.putawayAcceptedQuantity, 5);
  assert.equal(acceptedLineView.availableForNewPutaway, 5);
  assert.equal(acceptedLineView.remainingQuantityToPutaway, 5);
  assert.equal(acceptedLineView.putawayBlockedReason, null);

  const draftPutaway = await createDraftPutawayForReceiptLine(harness, accepted, { quantity: 2 });
  assert.equal(draftPutaway.status, 'draft');
  const afterDraftView = await fetchReceiptById(tenantId, accepted.receipt.id);
  const afterDraftLine = afterDraftView?.lines.find((line) => line.id === accepted.receiptLineId);
  assert.equal(afterDraftLine?.availableForNewPutaway, 3);
  assert.equal(afterDraftLine?.remainingQuantityToPutaway, 5);

  const postedPutaway = await postPutaway(tenantId, draftPutaway.id, {
    actor: { type: 'system', id: null }
  });
  assert.equal(postedPutaway.status, 'completed');
  const afterPostView = await fetchReceiptById(tenantId, accepted.receipt.id);
  const afterPostLine = afterPostView?.lines.find((line) => line.id === accepted.receiptLineId);
  assert.equal(afterPostLine?.availableForNewPutaway, 3);
  assert.equal(afterPostLine?.remainingQuantityToPutaway, 3);
  assert.equal(await harness.readOnHand(accepted.item.id, topology.defaults.QA.id), 3);
  assert.equal(await harness.readOnHand(accepted.item.id, topology.defaults.SELLABLE.id), 2);

  const acceptedLifecycle = await loadReceiptLifecycle(db, tenantId, accepted.receipt.id);
  assert.equal(acceptedLifecycle?.status, 'posted');
  assert.equal(acceptedLifecycle?.lifecycle_state, 'PUTAWAY_PENDING');

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

test('mixed-UOM putaway posts separate balanced transfer movements and replays without duplication', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-putaway-mixed-uom',
    tenantName: 'Contract Putaway Mixed UOM'
  });
  const { tenantId, pool: db, topology } = harness;
  const fixture = await createMultiLineReceiptInQa(harness, [
    { quantity: 10, uom: 'g', uomDimension: 'mass', canonicalUom: 'g', unitCost: 2 },
    { quantity: 20, uom: 'g', uomDimension: 'mass', canonicalUom: 'g', unitCost: 3 },
    { quantity: 4, uom: 'each', uomDimension: 'count', canonicalUom: 'each', unitCost: 1, type: 'packaging' }
  ]);

  for (const line of fixture.lines) {
    await createQcEvent(
      tenantId,
      {
        purchaseOrderReceiptLineId: line.id,
        eventType: 'accept',
        quantity: line.quantityReceived,
        uom: line.uom,
        actorType: 'system'
      },
      { idempotencyKey: `qc-mixed-accept:${line.id}:${randomUUID()}` }
    );
  }

  const putaway = await createPutaway(
    tenantId,
    {
      sourceType: 'purchase_order_receipt',
      purchaseOrderReceiptId: fixture.receipt.id,
      lines: fixture.lines.map((line, index) => ({
        lineNumber: index + 1,
        purchaseOrderReceiptLineId: line.id,
        toLocationId: topology.defaults.SELLABLE.id,
        uom: line.uom,
        quantity: line.quantityReceived
      }))
    },
    { type: 'system', id: null },
    { idempotencyKey: `putaway-mixed:${fixture.receipt.id}:${randomUUID()}` }
  );

  const posted = await postPutaway(tenantId, putaway.id, {
    actor: { type: 'system', id: null }
  });
  assert.equal(posted.status, 'completed');
  assert.ok(posted.lines.every((line) => line.status === 'completed'));
  assert.ok(posted.lines.every((line) => line.inventoryMovementId));

  const movementIds = Array.from(new Set(posted.lines.map((line) => line.inventoryMovementId)));
  assert.equal(movementIds.length, 2, 'mixed canonical UOM putaway must create one transfer movement per UOM group');

  const movementSummaries = await loadPutawayMovementSummaries(db, tenantId, putaway.id);
  assert.equal(movementSummaries.length, 2);
  for (const summary of movementSummaries) {
    assert.equal(summary.uomCount, 1);
    assert.ok(Math.abs(summary.netQty) < 1e-6, `movement ${summary.movementId} must be balanced`);
  }
  const gramsMovement = movementSummaries.find((summary) => summary.uoms.includes('g'));
  const eachMovement = movementSummaries.find((summary) => summary.uoms.includes('each'));
  assert.equal(gramsMovement?.putawayLineCount, 2);
  assert.equal(gramsMovement?.movementLineCount, 4);
  assert.equal(eachMovement?.putawayLineCount, 1);
  assert.equal(eachMovement?.movementLineCount, 2);

  const allocationResult = await db.query(
    `SELECT purchase_order_receipt_line_id AS "receiptLineId",
            location_id AS "locationId",
            status,
            quantity::numeric AS quantity,
            inventory_movement_id AS "movementId",
            inventory_movement_line_id AS "movementLineId"
       FROM receipt_allocations
      WHERE tenant_id = $1
        AND purchase_order_receipt_line_id = ANY($2::uuid[])
      ORDER BY purchase_order_receipt_line_id ASC, status ASC`,
    [tenantId, fixture.lines.map((line) => line.id)]
  );
  assert.equal(allocationResult.rowCount, fixture.lines.length);
  for (const allocation of allocationResult.rows) {
    const putawayLine = posted.lines.find((line) => line.purchaseOrderReceiptLineId === allocation.receiptLineId);
    assert.ok(putawayLine);
    assert.equal(allocation.status, 'AVAILABLE');
    assert.equal(allocation.locationId, topology.defaults.SELLABLE.id);
    assert.equal(allocation.movementId, putawayLine.inventoryMovementId);
    assert.ok(allocation.movementLineId);
    assert.ok(Math.abs(Number(allocation.quantity) - putawayLine.quantityMoved) < 1e-6);
  }

  const costResult = await db.query(
    `SELECT item_id AS "itemId",
            location_id AS "locationId",
            uom,
            COALESCE(SUM(remaining_quantity), 0)::numeric AS quantity
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND item_id = ANY($2::uuid[])
        AND voided_at IS NULL
      GROUP BY item_id, location_id, uom`,
    [tenantId, fixture.items.map((item) => item.id)]
  );
  const costQty = (itemId, locationId, uom) =>
    Number(costResult.rows.find((row) => row.itemId === itemId && row.locationId === locationId && row.uom === uom)?.quantity ?? 0);
  for (const [index, item] of fixture.items.entries()) {
    const line = fixture.lines[index];
    assert.equal(costQty(item.id, topology.defaults.QA.id, line.uom), 0);
    assert.ok(Math.abs(costQty(item.id, topology.defaults.SELLABLE.id, line.uom) - line.quantityReceived) < 1e-6);
  }

  const movementRowsBeforeReplay = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND external_ref LIKE $2`,
    [tenantId, `putaway:${putaway.id}:transfer:%`]
  );
  const transferLinksBeforeReplay = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM cost_layer_transfer_links
      WHERE tenant_id = $1
        AND transfer_movement_id = ANY($2::uuid[])`,
    [tenantId, movementIds]
  );

  const replayed = await postPutaway(tenantId, putaway.id, {
    actor: { type: 'system', id: null }
  });
  assert.equal(replayed.status, 'completed');
  assert.deepEqual(
    new Set(replayed.lines.map((line) => line.inventoryMovementId)),
    new Set(movementIds)
  );
  assert.equal(await loadMovementCountForPutaway(db, tenantId, putaway.id), 2);
  const movementRowsAfterReplay = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND external_ref LIKE $2`,
    [tenantId, `putaway:${putaway.id}:transfer:%`]
  );
  const transferLinksAfterReplay = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM cost_layer_transfer_links
      WHERE tenant_id = $1
        AND transfer_movement_id = ANY($2::uuid[])`,
    [tenantId, movementIds]
  );
  assert.equal(Number(movementRowsAfterReplay.rows[0]?.count ?? 0), Number(movementRowsBeforeReplay.rows[0]?.count ?? 0));
  assert.equal(Number(transferLinksAfterReplay.rows[0]?.count ?? 0), Number(transferLinksBeforeReplay.rows[0]?.count ?? 0));
});

test('same-UOM batched putaway still posts as one balanced transfer movement', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-putaway-same-uom',
    tenantName: 'Contract Putaway Same UOM'
  });
  const { tenantId, pool: db, topology } = harness;
  const fixture = await createMultiLineReceiptInQa(harness, [
    { quantity: 7, uom: 'g', uomDimension: 'mass', canonicalUom: 'g', unitCost: 2 },
    { quantity: 13, uom: 'g', uomDimension: 'mass', canonicalUom: 'g', unitCost: 3 }
  ]);

  for (const line of fixture.lines) {
    await createQcEvent(
      tenantId,
      {
        purchaseOrderReceiptLineId: line.id,
        eventType: 'accept',
        quantity: line.quantityReceived,
        uom: line.uom,
        actorType: 'system'
      },
      { idempotencyKey: `qc-same-accept:${line.id}:${randomUUID()}` }
    );
  }

  const putaway = await createPutaway(
    tenantId,
    {
      sourceType: 'purchase_order_receipt',
      purchaseOrderReceiptId: fixture.receipt.id,
      lines: fixture.lines.map((line, index) => ({
        lineNumber: index + 1,
        purchaseOrderReceiptLineId: line.id,
        toLocationId: topology.defaults.SELLABLE.id,
        uom: line.uom,
        quantity: line.quantityReceived
      }))
    },
    { type: 'system', id: null },
    { idempotencyKey: `putaway-same:${fixture.receipt.id}:${randomUUID()}` }
  );

  const posted = await postPutaway(tenantId, putaway.id, {
    actor: { type: 'system', id: null }
  });
  assert.equal(posted.status, 'completed');
  assert.equal(new Set(posted.lines.map((line) => line.inventoryMovementId)).size, 1);

  const movementSummaries = await loadPutawayMovementSummaries(db, tenantId, putaway.id);
  assert.equal(movementSummaries.length, 1);
  assert.deepEqual(movementSummaries[0].uoms, ['g']);
  assert.equal(movementSummaries[0].uomCount, 1);
  assert.equal(movementSummaries[0].putawayLineCount, 2);
  assert.equal(movementSummaries[0].movementLineCount, 4);
  assert.ok(Math.abs(movementSummaries[0].netQty) < 1e-6);
});

test('putaway route maps transfer balance invariant failures to actionable conflicts', () => {
  const mismatch = mapPutawayTransferInvariantError({
    code: 'P0001',
    message: 'TRANSFER_UOM_MISMATCH'
  });
  assert.equal(mismatch?.status, 409);
  assert.equal(mismatch?.body?.error?.code, 'TRANSFER_UOM_MISMATCH');
  assert.match(mismatch?.body?.error?.message, /multiple units of measure/);

  const unbalanced = mapPutawayTransferInvariantError({
    code: 'P0001',
    message: 'TRANSFER_NOT_BALANCED'
  });
  assert.equal(unbalanced?.status, 409);
  assert.equal(unbalanced?.body?.error?.code, 'TRANSFER_NOT_BALANCED');
  assert.match(unbalanced?.body?.error?.message, /quantities are not balanced/);
});

test('putaway posted event payload keeps primary movement id and includes all line movements', () => {
  const payload = buildPutawayPostedEventPayload({
    id: 'putaway-1',
    inventoryMovementId: 'movement-primary',
    lines: [
      {
        itemId: 'item-a',
        fromLocationId: 'qa',
        toLocationId: 'store',
        inventoryMovementId: 'movement-primary'
      },
      {
        itemId: 'item-b',
        fromLocationId: 'qa',
        toLocationId: 'store',
        inventoryMovementId: 'movement-secondary'
      },
      {
        itemId: 'item-b',
        fromLocationId: 'qa',
        toLocationId: 'store',
        inventoryMovementId: 'movement-secondary'
      }
    ]
  });

  assert.equal(payload.putawayId, 'putaway-1');
  assert.equal(payload.movementId, 'movement-primary');
  assert.equal(payload.primaryMovementId, 'movement-primary');
  assert.deepEqual(payload.movementIds.sort(), ['movement-primary', 'movement-secondary']);
  assert.deepEqual(payload.itemIds.sort(), ['item-a', 'item-b']);
  assert.deepEqual(payload.locationIds.sort(), ['qa', 'store']);
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

test('receipt QC accept rebuilds missing allocation state before validating accepted QA stock', { timeout: 240000 }, async () => {
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
  assert.equal(result.movementId, null);
  assert.equal(allocations.length, 1);
  assert.equal(allocations[0].status, 'QA');
  assert.equal(allocations[0].locationId, topology.defaults.QA.id);
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
  await postPutawayForReceiptLine(harness, fixture, { quantity: 6 });

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
      eventType: 'hold',
      quantity: 1,
      uom: 'each',
      actorType: 'system'
    },
    { idempotencyKey: `qc-receipt-unmatched:${randomUUID()}` }
  );
  await runInTransaction(db, async (client) => {
    await client.query(
      `DELETE FROM qc_inventory_links
        WHERE tenant_id = $1
          AND inventory_movement_id = $2`,
      [tenantId, result.movementId]
    );
    await assert.rejects(
      rebuildReceiptAllocations({
        client,
        tenantId,
        receiptId: fixture.receipt.id,
        occurredAt: new Date()
      }),
      /RECEIPT_AUTHORITATIVE_DATA_INCONSISTENT:qc_movement_missing/
    );
    throw new Error('ROLLBACK_EXPECTED');
  }).catch((error) => {
    if (error?.message !== 'ROLLBACK_EXPECTED') throw error;
  });
});

test('receipt allocation rebuild fails on authoritative movement ambiguity', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-qc-allocation-ambiguous',
    tenantName: 'Contract QC Allocation Ambiguous'
  });
  const { tenantId, pool: db } = harness;
  const fixture = await createReceiptInQa(harness, { quantity: 2 });
  const [initialAllocation] = await loadReceiptAllocations(db, tenantId, fixture.receiptLineId);

  await runInTransaction(db, async (client) => {
    await duplicateMovementLine(client, tenantId, initialAllocation.movementLineId);
    await client.query(
      `DELETE FROM receipt_allocations
        WHERE tenant_id = $1
          AND purchase_order_receipt_line_id = $2`,
      [tenantId, fixture.receiptLineId]
    );

    await assert.rejects(
      rebuildReceiptAllocations({
        client,
        tenantId,
        receiptId: fixture.receipt.id,
        occurredAt: new Date()
      }),
      /RECEIPT_AUTHORITATIVE_DATA_INCONSISTENT:movement_line_note_unmatched/
    );
    assert.equal((await loadReceiptAllocations(client, tenantId, fixture.receiptLineId)).length, 0);
    throw new Error('ROLLBACK_EXPECTED');
  }).catch((error) => {
    if (error?.message !== 'ROLLBACK_EXPECTED') throw error;
  });
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
  await postPutawayForReceiptLine(harness, fixture, { quantity: 5 });

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
  const qaAllocations = allocations.filter((a) => a.status === 'QA');
  const availableAllocations = allocations.filter((a) => a.status === 'AVAILABLE');
  const holdAllocations = allocations.filter((a) => a.status === 'HOLD');

  assert.equal(holdAllocations.length, 0, 'no HOLD allocations must remain');
  const totalQa = qaAllocations.reduce((sum, a) => sum + a.quantity, 0);
  const totalAvailable = availableAllocations.reduce((sum, a) => sum + a.quantity, 0);
  assert.ok(Math.abs(totalQa - 90) < 1e-6, 'accepted 90 must remain in QA until putaway');
  assert.ok(Math.abs(totalAvailable - 10) < 1e-6, 'released hold quantity follows hold-disposition release policy');

  for (const alloc of qaAllocations) {
    assert.equal(alloc.locationId, topology.defaults.QA.id, 'accepted receipt stock must remain in QA before putaway');
  }
  for (const alloc of availableAllocations) {
    assert.equal(alloc.locationId, topology.defaults.SELLABLE.id, 'released hold follows hold-disposition release location');
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
  const qaBefore = allocsBefore.filter((a) => a.status === 'QA');
  const totalQaBefore = qaBefore.reduce((sum, a) => sum + a.quantity, 0);
  assert.ok(Math.abs(totalQaBefore - 15) < 1e-6, 'accepted 15 must remain in QA before putaway');

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
  const qaAfter = allocsAfter.filter((a) => a.status === 'QA');
  const totalQaAfter = qaAfter.reduce((sum, a) => sum + a.quantity, 0);
  assert.ok(Math.abs(totalQaAfter - 15) < 1e-6, 'accepted 15 must remain in QA and be unaffected by rework');

  const reworkAllocs = allocsAfter.filter((a) => a.status === 'REWORK');
  assert.equal(reworkAllocs.length, 1, 'one REWORK terminal allocation must exist');
  assert.ok(Math.abs(reworkAllocs[0].quantity - 5) < 1e-6);

  const lifecycle = await loadReceiptLifecycle(db, tenantId, fixture.receipt.id);
  assert.equal(lifecycle?.lifecycle_state, 'QC_COMPLETED', 'QC must complete');
});
