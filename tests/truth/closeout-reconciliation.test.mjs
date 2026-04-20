import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServiceHarness } from '../helpers/service-harness.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { closePurchaseOrderReceipt, closePurchaseOrder } = require('../../src/services/closeout.service.ts');
const { buildReceiptCloseoutBlockers } = require('../../src/domain/receipts/receiptCloseoutPolicy.ts');

// ─────────────────────────────────────────────────────────────────────────────
// Closeout Reconciliation Truth Tests
//
// Prove that receipt closeout enforces reconciliation invariants:
// 1. Allocation totals must match received quantities
// 2. QC holds must be resolved before close
// 3. Discrepancies are detected and must be resolved
// 4. Adjustment resolutions create auditable ledger movements
// 5. Already-closed receipts are rejected
// 6. PO-level close requires all receipts closed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a receipt in QA for a given quantity, returning all context needed
 * for closeout testing.
 */
async function createReceiptInQa(harness, { quantity, unitCost = 5 }) {
  const item = await harness.createItem({
    defaultLocationId: harness.topology.defaults.SELLABLE.id,
    skuPrefix: `CLO-${randomUUID().slice(0, 6)}`,
    type: 'raw',
    defaultUom: 'each',
    canonicalUom: 'each',
    stockingUom: 'each'
  });
  const vendor = await harness.createVendor('CLO');
  const receipt = await harness.createReceipt({
    vendorId: vendor.id,
    itemId: item.id,
    locationId: harness.topology.defaults.QA.id,
    quantity,
    unitCost,
    uom: 'each',
    idempotencyKey: `clo-receipt:${randomUUID()}`
  });
  return {
    item,
    vendor,
    receipt,
    receiptLineId: receipt.lines[0].id
  };
}

test('clean receipt → full QC accept → closeout succeeds with no discrepancies', { timeout: 120000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-clo-clean',
    tenantName: 'Truth Closeout Clean'
  });
  const { tenantId, topology } = harness;

  const fixture = await createReceiptInQa(harness, { quantity: 10 });

  // QC accept all units → moves from QA to SELLABLE
  await harness.qcAcceptReceiptLine({
    receiptLineId: fixture.receiptLineId,
    quantity: 10,
    uom: 'each'
  });

  const result = await closePurchaseOrderReceipt(tenantId, fixture.receipt.id, {
    actorType: 'system',
    closeoutReasonCode: 'complete',
    notes: 'Clean closeout'
  });

  assert.ok(result, 'closeout returns reconciliation');
  assert.equal(result.receipt.closeout.status, 'closed', 'receipt is closed');
  assert.equal(
    result.discrepancies.filter((d) => d.status === 'OPEN').length,
    0,
    'no open discrepancies'
  );
});

test('receipt with unresolved QC hold blocks closeout', { timeout: 120000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-clo-hold',
    tenantName: 'Truth Closeout Hold Block'
  });
  const { tenantId } = harness;

  const fixture = await createReceiptInQa(harness, { quantity: 8 });

  // Accept only 5 of 8 → 3 remain on QC hold
  await harness.qcAcceptReceiptLine({
    receiptLineId: fixture.receiptLineId,
    quantity: 5,
    uom: 'each'
  });

  // Closeout without resolving hold should fail
  await assert.rejects(
    closePurchaseOrderReceipt(tenantId, fixture.receipt.id, {
      actorType: 'system',
      closeoutReasonCode: 'complete',
      notes: 'Should fail — hold unresolved'
    }),
    (err) => {
      assert.equal(err.message, 'RECEIPT_NOT_ELIGIBLE');
      assert.ok(err.reasons.length > 0, 'at least one blocker reason');
      assert.ok(
        err.reasons.some((r) => r.includes('hold') || r.includes('putaway') || r.includes('allocation') || r.includes('reconciliation') || r.includes('bins')),
        `expected closeout blocker, got: ${JSON.stringify(err.reasons)}`
      );
      return true;
    }
  );
});

test('closeout policy unit: all four blockers detected independently', () => {
  // 1. Open discrepancies
  const disc = buildReceiptCloseoutBlockers({
    lineFacts: [],
    openDiscrepancyCount: 1
  });
  assert.ok(disc.some((r) => r.includes('reconciliation')));

  // 2. Allocation mismatch
  const alloc = buildReceiptCloseoutBlockers({
    lineFacts: [{ remainingToPutaway: 0, holdQty: 0, allocationQuantityMatchesReceipt: false }],
    openDiscrepancyCount: 0
  });
  assert.ok(alloc.some((r) => r.includes('allocation')));

  // 3. QC hold unresolved
  const hold = buildReceiptCloseoutBlockers({
    lineFacts: [{ remainingToPutaway: 0, holdQty: 1, allocationQuantityMatchesReceipt: true }],
    openDiscrepancyCount: 0
  });
  assert.ok(hold.some((r) => r.includes('hold')));

  // 4. Putaway incomplete
  const putaway = buildReceiptCloseoutBlockers({
    lineFacts: [{ remainingToPutaway: 1, holdQty: 0, allocationQuantityMatchesReceipt: true }],
    openDiscrepancyCount: 0
  });
  assert.ok(putaway.some((r) => r.includes('putaway') || r.includes('bin')));

  // Clean: no blockers
  const clean = buildReceiptCloseoutBlockers({
    lineFacts: [{ remainingToPutaway: 0, holdQty: 0, allocationQuantityMatchesReceipt: true }],
    openDiscrepancyCount: 0
  });
  assert.equal(clean.length, 0, 'no blockers when all conditions met');
});

test('physical count discrepancy → adjustment resolution → closeout creates auditable movement', { timeout: 120000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-clo-adj',
    tenantName: 'Truth Closeout Adjustment Resolution'
  });
  const { tenantId, topology, pool: db } = harness;

  const fixture = await createReceiptInQa(harness, { quantity: 10, unitCost: 4 });
  const sellableBinId = (await db.query(
    `SELECT id FROM inventory_bins WHERE tenant_id = $1 AND location_id = $2 AND is_default = true`,
    [tenantId, topology.defaults.SELLABLE.id]
  )).rows[0]?.id;

  // QC accept all 10
  await harness.qcAcceptReceiptLine({
    receiptLineId: fixture.receiptLineId,
    quantity: 10,
    uom: 'each'
  });

  // Physical count finds only 8 → discrepancy of -2
  const result = await closePurchaseOrderReceipt(tenantId, fixture.receipt.id, {
    actorType: 'system',
    closeoutReasonCode: 'short_ship',
    notes: 'Physical count finds shortage',
    physicalCounts: [
      {
        purchaseOrderReceiptLineId: fixture.receiptLineId,
        locationId: topology.defaults.SELLABLE.id,
        binId: sellableBinId,
        allocationStatus: 'AVAILABLE',
        countedQty: 8,
        toleranceQty: 0
      }
    ],
    resolution: {
      mode: 'adjustment',
      notes: 'Adjust for shortage found during closeout'
    }
  });

  assert.equal(result.receipt.closeout.status, 'closed', 'receipt is closed after adjustment');

  // Verify the adjustment created a ledger movement
  const resolvedDiscrepancies = result.discrepancies.filter((d) => d.status !== 'OPEN');
  assert.ok(resolvedDiscrepancies.length > 0, 'discrepancies were resolved');

  // Verify ledger has an adjustment movement for the shortage
  const movementResult = await db.query(
    `SELECT im.id, im.movement_type, iml.reason_code
       FROM inventory_movements im
       JOIN inventory_movement_lines iml ON iml.movement_id = im.id AND iml.tenant_id = im.tenant_id
      WHERE im.tenant_id = $1
        AND iml.reason_code = 'receipt_reconciliation'
      ORDER BY im.created_at DESC
      LIMIT 1`,
    [tenantId]
  );
  assert.ok(movementResult.rows.length > 0, 'adjustment movement exists in ledger');

  // Verify on-hand reflects the adjustment (10 received - 2 adjustment = 8)
  const onHand = await harness.readOnHand(fixture.item.id, topology.defaults.SELLABLE.id);
  assert.equal(onHand, 8, 'on-hand reflects adjustment (10 - 2)');

  // Verify no quantity conservation mismatches
  const mismatches = await harness.findQuantityConservationMismatches();
  assert.equal(mismatches.length, 0, 'zero quantity conservation mismatches after closeout adjustment');
});

test('already-closed receipt rejects double-close', { timeout: 120000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-clo-idem',
    tenantName: 'Truth Closeout Idempotent'
  });
  const { tenantId } = harness;

  const fixture = await createReceiptInQa(harness, { quantity: 5 });

  await harness.qcAcceptReceiptLine({
    receiptLineId: fixture.receiptLineId,
    quantity: 5,
    uom: 'each'
  });

  await closePurchaseOrderReceipt(tenantId, fixture.receipt.id, {
    actorType: 'system',
    closeoutReasonCode: 'complete',
    notes: 'First close'
  });

  await assert.rejects(
    closePurchaseOrderReceipt(tenantId, fixture.receipt.id, {
      actorType: 'system',
      closeoutReasonCode: 'complete',
      notes: 'Second close should fail'
    }),
    (err) => {
      assert.equal(err.message, 'RECEIPT_ALREADY_CLOSED');
      return true;
    }
  );
});

test('PO-level close requires all receipts closed', { timeout: 120000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-clo-po',
    tenantName: 'Truth Closeout PO Level'
  });
  const { tenantId, topology } = harness;

  const vendor = await harness.createVendor('CLO-PO');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'CLO-PO',
    type: 'raw'
  });

  const po = await harness.createPurchaseOrder({
    vendorId: vendor.id,
    shipToLocationId: topology.defaults.QA.id,
    receivingLocationId: topology.defaults.QA.id,
    expectedDate: '2026-07-01',
    status: 'approved',
    lines: [{ itemId: item.id, uom: 'each', quantityOrdered: 10, unitCost: 3, currencyCode: 'THB' }]
  });

  // Post receipt
  const receipt = await harness.postReceipt({
    purchaseOrderId: po.id,
    receivedAt: '2026-07-01T00:00:00.000Z',
    receivedToLocationId: topology.defaults.QA.id,
    idempotencyKey: `clo-po-receipt:${randomUUID()}`,
    lines: [{ purchaseOrderLineId: po.lines[0].id, uom: 'each', quantityReceived: 10, unitCost: 3 }]
  });

  // PO close should fail if receipt is not closed
  await assert.rejects(
    closePurchaseOrder(tenantId, po.id, { notes: 'Should fail' }),
    (err) => {
      assert.ok(
        err.message === 'PO_RECEIPTS_NOT_CLOSED' || err.message === 'PO_RECEIPTS_OPEN' || err.message.includes('not closed') || err.message.includes('NOT_CLOSED'),
        `expected PO close rejection, got: ${err.message}`
      );
      return true;
    }
  );

  // QC accept and close the receipt
  await harness.qcAcceptReceiptLine({
    receiptLineId: receipt.receipt.lines[0].id,
    quantity: 10,
    uom: 'each'
  });

  await closePurchaseOrderReceipt(tenantId, receipt.receipt.id, {
    actorType: 'system',
    closeoutReasonCode: 'complete',
    notes: 'Close before PO close'
  });

  // Now PO close should succeed
  const poResult = await closePurchaseOrder(tenantId, po.id, { notes: 'PO closeout' });
  assert.ok(poResult, 'PO close succeeds');
});

test('closeout adjustment resolution preserves ledger rebuild parity', { timeout: 120000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-clo-rebuild',
    tenantName: 'Truth Closeout Rebuild Parity'
  });
  const { tenantId, topology, pool: db } = harness;

  const fixture = await createReceiptInQa(harness, { quantity: 12, unitCost: 6 });
  const sellableBinId = (await db.query(
    `SELECT id FROM inventory_bins WHERE tenant_id = $1 AND location_id = $2 AND is_default = true`,
    [tenantId, topology.defaults.SELLABLE.id]
  )).rows[0]?.id;

  await harness.qcAcceptReceiptLine({
    receiptLineId: fixture.receiptLineId,
    quantity: 12,
    uom: 'each'
  });

  // Physical count: only 9 found
  await closePurchaseOrderReceipt(tenantId, fixture.receipt.id, {
    actorType: 'system',
    closeoutReasonCode: 'short_ship',
    notes: 'Shortage found',
    physicalCounts: [
      {
        purchaseOrderReceiptLineId: fixture.receiptLineId,
        locationId: topology.defaults.SELLABLE.id,
        binId: sellableBinId,
        allocationStatus: 'AVAILABLE',
        countedQty: 9,
        toleranceQty: 0
      }
    ],
    resolution: {
      mode: 'adjustment',
      notes: 'Closeout adjustment'
    }
  });

  // Snapshot live projections
  const before = await harness.snapshotDerivedProjections();

  // Clear and rebuild from ledger
  await harness.clearDerivedProjections();
  await harness.rebuildDerivedProjections();

  const after = await harness.snapshotDerivedProjections();

  // Balance rebuild parity — filter out zero-balance rows that live projections
  // retain from intermediate movements (e.g. QA → SELLABLE) but rebuild omits.
  const nonZero = (rows) => rows.filter((r) => r.onHand !== 0 || r.reserved !== 0 || r.allocated !== 0);
  assert.deepStrictEqual(nonZero(after.inventoryBalance), nonZero(before.inventoryBalance), 'balance rebuild parity');

  // Item summary parity
  const liveSummary = before.itemSummaries.find((s) => s.itemId === fixture.item.id);
  const rebuiltSummary = after.itemSummaries.find((s) => s.itemId === fixture.item.id);
  assert.ok(liveSummary, 'live summary exists');
  assert.ok(rebuiltSummary, 'rebuilt summary exists');
  assert.equal(
    liveSummary.quantityOnHand,
    rebuiltSummary.quantityOnHand,
    'item summary matches ledger-derived rebuild after closeout adjustment'
  );
});
