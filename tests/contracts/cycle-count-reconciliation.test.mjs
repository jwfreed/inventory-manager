/**
 * WP7 — Cycle Count Reconciliation contract tests.
 *
 * Covers:
 *   A. Zero variance → no movement, task reconciled
 *   B. Positive variance → adjustment IN movement, conservation holds
 *   C. Negative variance → adjustment OUT movement, conservation holds
 *   D. Reason code required for non-zero variance
 *   E. Double reconciliation is idempotent (second call returns same result)
 *   F. Snapshot stability: system_qty_snapshot is stable even if inventory changes after creation
 *   G. recordCount rejects negative counted quantity
 *   H. reconcileTask rejects task that hasn't been counted yet
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

async function setup(prefix) {
  const harness = await createServiceHarness({
    tenantPrefix: prefix,
    tenantName: `CC Reconciliation ${prefix}`
  });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'CCR',
    type: 'raw'
  });
  return { harness, item, topology };
}

async function seedStock(harness, item, topology, quantity, unitCost = 10) {
  return harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity,
    unitCost,
    countedAt: '2026-01-01T00:00:00.000Z'
  });
}

async function createDraft(harness, item, topology, { countedQty, reasonCode, unitCost = null }) {
  return harness.createInventoryCountDraft(
    {
      countedAt: new Date().toISOString(),
      warehouseId: topology.warehouse.id,
      locationId: topology.defaults.SELLABLE.id,
      lines: [
        {
          itemId: item.id,
          locationId: topology.defaults.SELLABLE.id,
          uom: 'each',
          countedQuantity: countedQty,
          unitCostForPositiveAdjustment: unitCost,
          reasonCode: reasonCode ?? null
        }
      ]
    },
    { idempotencyKey: `ccr-draft:${randomUUID()}` }
  );
}

// ── A. Zero variance ──────────────────────────────────────────────────────────

test('A. zero variance reconciles without creating a movement', async () => {
  const { harness, item, topology } = await setup('ccr-a');
  await seedStock(harness, item, topology, 10);
  const onHandBefore = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);
  assert.equal(onHandBefore, 10);

  // Draft with countedQty = system on-hand (zero variance)
  const draft = await createDraft(harness, item, topology, {
    countedQty: 10,
    reasonCode: null
  });
  assert.equal(draft.status, 'draft');
  const line = draft.lines[0];
  assert.equal(line.systemQtySnapshot, 10);

  // recordCount: set counted_qty to exactly the snapshot
  await harness.recordCount(draft.id, line.id, 10);

  // reconcileTask: zero variance → no movement
  const idempotencyKey = `ccr-a-reconcile:${randomUUID()}`;
  const result = await harness.reconcileTask(draft.id, line.id, idempotencyKey);

  const reconciledLine = result.lines[0];
  assert.equal(reconciledLine.taskStatus, 'reconciled');
  assert.equal(reconciledLine.varianceQuantity, 0);
  assert.equal(reconciledLine.reconciledMovementId, null);

  // No inventory change
  assert.equal(await harness.readOnHand(item.id, topology.defaults.SELLABLE.id), 10);

  // No spurious movement
  const { pool: db, tenantId } = harness;
  const movRes = await db.query(
    `SELECT count(*)::int AS cnt FROM inventory_movements
      WHERE tenant_id = $1 AND source_type = 'cycle_count_task' AND source_id = $2`,
    [tenantId, line.id]
  );
  assert.equal(movRes.rows[0].cnt, 0);
});

// ── B. Positive variance ──────────────────────────────────────────────────────

test('B. positive variance posts adjustment IN and conserves inventory', async () => {
  const { harness, item, topology } = await setup('ccr-b');
  await seedStock(harness, item, topology, 5, 10);

  const draft = await createDraft(harness, item, topology, {
    countedQty: 8, // physical count finds 3 more than system
    reasonCode: 'MISLOCATION',
    unitCost: 10
  });
  const line = draft.lines[0];
  assert.equal(line.systemQtySnapshot, 5);

  await harness.recordCount(draft.id, line.id, 8);

  const idempotencyKey = `ccr-b-reconcile:${randomUUID()}`;
  const result = await harness.reconcileTask(draft.id, line.id, idempotencyKey, {
    reasonCode: 'MISLOCATION'
  });

  const reconciledLine = result.lines[0];
  assert.equal(reconciledLine.taskStatus, 'reconciled');
  assert.equal(reconciledLine.varianceQuantity, 3);
  assert.ok(reconciledLine.reconciledMovementId, 'movement must be created for non-zero variance');

  // Inventory increased to 8
  assert.equal(await harness.readOnHand(item.id, topology.defaults.SELLABLE.id), 8);

  // Movement is an adjustment
  const { pool: db, tenantId } = harness;
  const movRes = await db.query(
    `SELECT movement_type, source_type FROM inventory_movements
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, reconciledLine.reconciledMovementId]
  );
  assert.equal(movRes.rowCount, 1);
  assert.equal(movRes.rows[0].movement_type, 'adjustment');
  assert.equal(movRes.rows[0].source_type, 'cycle_count_task');

  // Conservation
  assert.deepEqual(await harness.findQuantityConservationMismatches(), []);
  assert.deepEqual(await harness.findCostLayerConsistencyMismatches(), []);
});

// ── C. Negative variance ──────────────────────────────────────────────────────

test('C. negative variance posts adjustment OUT and conserves inventory', async () => {
  const { harness, item, topology } = await setup('ccr-c');
  await seedStock(harness, item, topology, 20, 5);

  const draft = await createDraft(harness, item, topology, {
    countedQty: 17, // physical count is 3 fewer
    reasonCode: 'SHRINKAGE'
  });
  const line = draft.lines[0];
  assert.equal(line.systemQtySnapshot, 20);

  await harness.recordCount(draft.id, line.id, 17);

  const idempotencyKey = `ccr-c-reconcile:${randomUUID()}`;
  const result = await harness.reconcileTask(draft.id, line.id, idempotencyKey, {
    reasonCode: 'SHRINKAGE'
  });

  const reconciledLine = result.lines[0];
  assert.equal(reconciledLine.taskStatus, 'reconciled');
  assert.equal(reconciledLine.varianceQuantity, -3);
  assert.ok(reconciledLine.reconciledMovementId);

  // Inventory decreased to 17
  assert.equal(await harness.readOnHand(item.id, topology.defaults.SELLABLE.id), 17);

  // Movement has negative quantity_delta
  const { pool: db, tenantId } = harness;
  const lineRes = await db.query(
    `SELECT quantity_delta::numeric AS qty FROM inventory_movement_lines
      WHERE tenant_id = $1 AND movement_id = $2`,
    [tenantId, reconciledLine.reconciledMovementId]
  );
  assert.equal(lineRes.rowCount, 1);
  assert.ok(Number(lineRes.rows[0].qty) < 0, 'quantity_delta must be negative for loss');

  // Conservation
  assert.deepEqual(await harness.findQuantityConservationMismatches(), []);
  assert.deepEqual(await harness.findCostLayerConsistencyMismatches(), []);
});

// ── D. Reason code required for non-zero variance ─────────────────────────────

test('D. reason code is required for non-zero variance', async () => {
  const { harness, item, topology } = await setup('ccr-d');
  await seedStock(harness, item, topology, 10);

  // countedQty deliberately different from system_qty, no reasonCode stored on line
  const draft = await harness.createInventoryCountDraft(
    {
      countedAt: new Date().toISOString(),
      warehouseId: topology.warehouse.id,
      locationId: topology.defaults.SELLABLE.id,
      lines: [
        {
          itemId: item.id,
          locationId: topology.defaults.SELLABLE.id,
          uom: 'each',
          countedQuantity: 7
          // no reasonCode
        }
      ]
    },
    { idempotencyKey: `ccr-d-draft:${randomUUID()}` }
  );
  const line = draft.lines[0];
  await harness.recordCount(draft.id, line.id, 7);

  // reconcileTask without reasonCode → COUNT_REASON_REQUIRED
  await assert.rejects(
    () =>
      harness.reconcileTask(draft.id, line.id, `ccr-d-reconcile:${randomUUID()}`, {
        reasonCode: null
      }),
    (err) => {
      assert.equal(err.message, 'COUNT_REASON_REQUIRED');
      return true;
    }
  );

  // No movement created
  const { pool: db, tenantId } = harness;
  const movRes = await db.query(
    `SELECT count(*)::int AS cnt FROM inventory_movements
      WHERE tenant_id = $1 AND source_type = 'cycle_count_task' AND source_id = $2`,
    [tenantId, line.id]
  );
  assert.equal(movRes.rows[0].cnt, 0);
});

// ── E. Double reconciliation is idempotent ────────────────────────────────────

test('E. double reconciliation is idempotent (same idempotency key)', async () => {
  const { harness, item, topology } = await setup('ccr-e');
  await seedStock(harness, item, topology, 10);

  const draft = await createDraft(harness, item, topology, {
    countedQty: 8,
    reasonCode: 'SHRINKAGE'
  });
  const line = draft.lines[0];
  await harness.recordCount(draft.id, line.id, 8);

  const idempotencyKey = `ccr-e-reconcile:${randomUUID()}`;
  const first = await harness.reconcileTask(draft.id, line.id, idempotencyKey, {
    reasonCode: 'SHRINKAGE'
  });
  assert.equal(first.lines[0].taskStatus, 'reconciled');

  // Second call with same idempotency key → returns same result
  const second = await harness.reconcileTask(draft.id, line.id, idempotencyKey, {
    reasonCode: 'SHRINKAGE'
  });
  assert.equal(second.lines[0].taskStatus, 'reconciled');
  assert.equal(second.lines[0].reconciledMovementId, first.lines[0].reconciledMovementId);

  // Only one movement exists
  const { pool: db, tenantId } = harness;
  const movRes = await db.query(
    `SELECT count(*)::int AS cnt FROM inventory_movements
      WHERE tenant_id = $1 AND source_type = 'cycle_count_task' AND source_id = $2`,
    [tenantId, line.id]
  );
  assert.equal(movRes.rows[0].cnt, 1);

  // On-hand unchanged after second call
  assert.equal(await harness.readOnHand(item.id, topology.defaults.SELLABLE.id), 8);
});

// ── F. Snapshot stability ────────────────────────────────────────────────────

test('F. system_qty_snapshot is stable even when inventory changes after draft creation', async () => {
  const { harness, item, topology } = await setup('ccr-f');
  await seedStock(harness, item, topology, 10);

  // Create draft — snapshot captures 10
  const draft = await createDraft(harness, item, topology, {
    countedQty: 10,
    reasonCode: null
  });
  const line = draft.lines[0];
  assert.equal(line.systemQtySnapshot, 10, 'snapshot must equal on-hand at draft time');

  // Simulate inventory change AFTER draft creation (another receipt arrives)
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 10,
    countedAt: new Date().toISOString()
  });
  // on-hand is now 15, but the snapshot was captured at 10

  // Physical count: counter physically counted 10 (matching original snapshot)
  await harness.recordCount(draft.id, line.id, 10);

  // Reload draft to confirm snapshot is still 10
  const reloaded = await harness.getInventoryCount(draft.id);
  assert.equal(reloaded.lines[0].systemQtySnapshot, 10, 'snapshot must not change after inventory mutation');

  // variance = 10 - 10 = 0 → no movement
  const result = await harness.reconcileTask(
    draft.id,
    line.id,
    `ccr-f-reconcile:${randomUUID()}`
  );
  assert.equal(result.lines[0].varianceQuantity, 0);
  assert.equal(result.lines[0].reconciledMovementId, null);
});

// ── G. recordCount rejects negative counted quantity ─────────────────────────

test('G. recordCount rejects negative counted quantity', async () => {
  const { harness, item, topology } = await setup('ccr-g');
  await seedStock(harness, item, topology, 10);

  const draft = await createDraft(harness, item, topology, {
    countedQty: 10,
    reasonCode: null
  });
  const line = draft.lines[0];

  await assert.rejects(
    () => harness.recordCount(draft.id, line.id, -1),
    (err) => {
      assert.equal(err.message, 'COUNT_QUANTITY_NONNEGATIVE');
      return true;
    }
  );
});

// ── H. reconcileTask rejects un-counted task ──────────────────────────────────

test('H. reconcileTask rejects a task that has not been counted yet', async () => {
  const { harness, item, topology } = await setup('ccr-h');
  await seedStock(harness, item, topology, 10);

  const draft = await createDraft(harness, item, topology, {
    countedQty: 7,
    reasonCode: 'SHRINKAGE'
  });
  const line = draft.lines[0];
  // Do NOT call recordCount — task_status stays 'pending'

  await assert.rejects(
    () =>
      harness.reconcileTask(draft.id, line.id, `ccr-h-reconcile:${randomUUID()}`, {
        reasonCode: 'SHRINKAGE'
      }),
    (err) => {
      assert.equal(err.message, 'COUNT_TASK_NOT_COUNTED');
      return true;
    }
  );
});
