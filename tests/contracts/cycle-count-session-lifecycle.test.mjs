import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setup(prefix) {
  const harness = await createServiceHarness({
    tenantPrefix: prefix,
    tenantName: `CC Session Lifecycle ${prefix}`
  });
  const { topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'CCSL',
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

/**
 * Create a draft cycle count with a single line.
 */
async function createDraft(harness, item, topology, { countedQty = 0, reasonCode = null, unitCost = null } = {}) {
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
    { idempotencyKey: `draft:${randomUUID()}` }
  );
}

/** Reconcile all pending/counted tasks in a session. */
async function reconcileAll(harness, draft) {
  let result = draft;
  for (const line of result.lines) {
    if (line.taskStatus !== 'reconciled') {
      result = await harness.reconcileTask(draft.id, line.id, `reconcile:${randomUUID()}`, {
        reasonCode: line.varianceQuantity !== 0 ? 'SHRINKAGE' : null
      });
    }
  }
  return result;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('A. cannot complete session with unreconciled lines', async () => {
  const { harness, item, topology } = await setup('ccsl-a');
  await seedStock(harness, item, topology, 10);

  const draft = await createDraft(harness, item, topology, { countedQty: 10 });
  const line = draft.lines[0];

  // Move to in_progress by recording count, but do NOT reconcile
  await harness.recordCount(draft.id, line.id, 10);

  const reloaded = await harness.getInventoryCount(draft.id);
  assert.equal(reloaded.status, 'in_progress');

  await assert.rejects(
    () => harness.completeCycleCount(draft.id),
    (err) => {
      assert.equal(err.message, 'COUNT_COMPLETION_INCOMPLETE');
      return true;
    }
  );

  // Status unchanged
  const still = await harness.getInventoryCount(draft.id);
  assert.equal(still.status, 'in_progress');
});

test('B. completes when all lines are reconciled', async () => {
  const { harness, item, topology } = await setup('ccsl-b');
  await seedStock(harness, item, topology, 10);

  const draft = await createDraft(harness, item, topology, { countedQty: 10 });
  const line = draft.lines[0];

  await harness.recordCount(draft.id, line.id, 10);
  await harness.reconcileTask(draft.id, line.id, `reconcile:${randomUUID()}`);

  const result = await harness.completeCycleCount(draft.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.progress.reconciledLines, 1);
  assert.equal(result.progress.totalLines, 1);
  assert.equal(result.progress.completionProgress, 1);
  assert.equal(result.progress.pendingLines, 0);
  assert.equal(result.progress.countedLines, 0);
});

test('C. cannot modify lines once session is in_progress', async () => {
  const { harness, item, topology } = await setup('ccsl-c');
  await seedStock(harness, item, topology, 10);

  const draft = await createDraft(harness, item, topology, { countedQty: 10 });
  const line = draft.lines[0];

  // Transition to in_progress
  await harness.recordCount(draft.id, line.id, 10);

  const reloaded = await harness.getInventoryCount(draft.id);
  assert.equal(reloaded.status, 'in_progress');

  // updateInventoryCount must be blocked
  await assert.rejects(
    () =>
      harness.updateInventoryCount(draft.id, {
        lines: [
          {
            itemId: item.id,
            locationId: topology.defaults.SELLABLE.id,
            uom: 'each',
            countedQuantity: 99
          }
        ]
      }),
    (err) => {
      assert.equal(err.message, 'COUNT_MUTATION_NOT_ALLOWED');
      return true;
    }
  );

  // Lines unchanged
  const after = await harness.getInventoryCount(draft.id);
  assert.equal(after.lines[0].countedQuantity, 10);
});

test('D. no mutations allowed after session is completed', async () => {
  const { harness, item, topology } = await setup('ccsl-d');
  await seedStock(harness, item, topology, 10);

  const draft = await createDraft(harness, item, topology, { countedQty: 10 });
  const line = draft.lines[0];

  await harness.recordCount(draft.id, line.id, 10);
  await harness.reconcileTask(draft.id, line.id, `reconcile:${randomUUID()}`);
  await harness.completeCycleCount(draft.id);

  // updateInventoryCount blocked
  await assert.rejects(
    () =>
      harness.updateInventoryCount(draft.id, {
        lines: [
          {
            itemId: item.id,
            locationId: topology.defaults.SELLABLE.id,
            uom: 'each',
            countedQuantity: 5
          }
        ]
      }),
    (err) => {
      assert.equal(err.message, 'COUNT_ALREADY_COMPLETED');
      return true;
    }
  );

  // recordCount blocked
  await assert.rejects(
    () => harness.recordCount(draft.id, line.id, 5),
    (err) => {
      assert.equal(err.message, 'COUNT_ALREADY_COMPLETED');
      return true;
    }
  );

  // reconcileTask blocked
  await assert.rejects(
    () =>
      harness.reconcileTask(draft.id, line.id, `reconcile:${randomUUID()}`),
    (err) => {
      assert.equal(err.message, 'COUNT_ALREADY_COMPLETED');
      return true;
    }
  );
});

test('E. system_qty_snapshot is immutable once in_progress (update blocked)', async () => {
  const { harness, item, topology } = await setup('ccsl-e');
  await seedStock(harness, item, topology, 10);

  const draft = await createDraft(harness, item, topology, { countedQty: 10 });
  const line = draft.lines[0];
  assert.equal(line.systemQtySnapshot, 10, 'snapshot captured at draft time');

  // Transition to in_progress
  await harness.recordCount(draft.id, line.id, 10);

  // Add more stock — system now has 15
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 10,
    countedAt: new Date().toISOString()
  });

  // Update attempt is blocked; snapshot cannot be overwritten
  await assert.rejects(
    () =>
      harness.updateInventoryCount(draft.id, {
        lines: [
          {
            itemId: item.id,
            locationId: topology.defaults.SELLABLE.id,
            uom: 'each',
            countedQuantity: 10
          }
        ]
      }),
    (err) => {
      assert.equal(err.message, 'COUNT_MUTATION_NOT_ALLOWED');
      return true;
    }
  );

  // Snapshot is still 10
  const reloaded = await harness.getInventoryCount(draft.id);
  assert.equal(reloaded.lines[0].systemQtySnapshot, 10, 'snapshot must not change');
});

test('F. partial reconciliation is allowed but blocks completion', async () => {
  const { harness, item, topology } = await setup('ccsl-f');
  await seedStock(harness, item, topology, 20);

  // Two items in the same warehouse/location
  const item2 = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'CCSL-F2',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item2.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 15,
    unitCost: 10,
    countedAt: '2026-01-01T00:00:00.000Z'
  });

  const draft1 = await harness.createInventoryCountDraft(
    {
      countedAt: new Date().toISOString(),
      warehouseId: topology.warehouse.id,
      locationId: topology.defaults.SELLABLE.id,
      lines: [
        {
          itemId: item.id,
          locationId: topology.defaults.SELLABLE.id,
          uom: 'each',
          countedQuantity: 20
        },
        {
          itemId: item2.id,
          locationId: topology.defaults.SELLABLE.id,
          uom: 'each',
          countedQuantity: 15
        }
      ]
    },
    { idempotencyKey: `ccsl-f-draft:${randomUUID()}` }
  );

  const [lineA, lineB] = draft1.lines;

  // Record both
  await harness.recordCount(draft1.id, lineA.id, 20);
  await harness.recordCount(draft1.id, lineB.id, 15);

  // Reconcile only lineA
  await harness.reconcileTask(draft1.id, lineA.id, `reconcile-a:${randomUUID()}`);

  // Partial state: lineA reconciled, lineB counted
  const partial = await harness.getInventoryCount(draft1.id);
  assert.equal(partial.status, 'in_progress');
  assert.equal(partial.progress.reconciledLines, 1);
  assert.equal(partial.progress.countedLines, 1);
  assert.equal(partial.progress.pendingLines, 0);
  assert.ok(partial.progress.completionProgress > 0 && partial.progress.completionProgress < 1);

  // Completion blocked
  await assert.rejects(
    () => harness.completeCycleCount(draft1.id),
    (err) => {
      assert.equal(err.message, 'COUNT_COMPLETION_INCOMPLETE');
      return true;
    }
  );

  // Reconcile lineB
  await harness.reconcileTask(draft1.id, lineB.id, `reconcile-b:${randomUUID()}`);

  // Now completion succeeds
  const done = await harness.completeCycleCount(draft1.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.progress.reconciledLines, 2);
  assert.equal(done.progress.totalLines, 2);
  assert.equal(done.progress.completionProgress, 1);
});

test('G. concurrent reconcile + complete does not violate the all-reconciled invariant', async () => {
  const { harness, item, topology } = await setup('ccsl-g');
  await seedStock(harness, item, topology, 10);

  // Single-line session
  const draft = await createDraft(harness, item, topology, { countedQty: 10 });
  const line = draft.lines[0];

  await harness.recordCount(draft.id, line.id, 10);

  // Attempt completion BEFORE reconcile — must fail
  await assert.rejects(
    () => harness.completeCycleCount(draft.id),
    (err) => {
      assert.equal(err.message, 'COUNT_COMPLETION_INCOMPLETE');
      return true;
    }
  );

  // Reconcile, then complete races: fire both concurrently
  const idempotencyKey = `reconcile-g:${randomUUID()}`;
  const [reconcileResult, completeResult] = await Promise.allSettled([
    harness.reconcileTask(draft.id, line.id, idempotencyKey),
    harness.completeCycleCount(draft.id)
  ]);

  // Exactly one of them may have won the race; the other may have failed or
  // succeeded. After both settle, the invariant must hold:
  //   if status = 'completed' then all lines reconciled.
  const final = await harness.getInventoryCount(draft.id);

  if (final.status === 'completed') {
    assert.equal(final.progress.reconciledLines, final.progress.totalLines);
    assert.equal(final.progress.completionProgress, 1);
  } else {
    // completeCycleCount lost the race; reconcile may or may not have finished
    assert.ok(
      ['in_progress', 'draft'].includes(final.status),
      `unexpected status: ${final.status}`
    );
  }

  // At minimum, the line must be reconciled (reconcileTask won or tied)
  // — unless completeCycleCount blocked it (impossible by contract)
  // Drive to completion deterministically
  if (final.status !== 'completed') {
    // reconcile if not yet done
    if (final.lines[0].taskStatus !== 'reconciled') {
      await harness.reconcileTask(draft.id, line.id, idempotencyKey);
    }
    const completed = await harness.completeCycleCount(draft.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.progress.reconciledLines, completed.progress.totalLines);
  }

  // Conservation sanity
  assert.deepEqual(await harness.findQuantityConservationMismatches(), []);
});
