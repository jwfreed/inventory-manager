import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';

test('cycle count variance is observable before correction and propagates cleanly after reconciliation', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-record-physical',
    tenantName: 'Truth Record Physical Reconciliation'
  });
  const { tenantId, pool: db, topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'TRUTH-RECON',
    type: 'raw'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });
  const recordedOnHandBeforeCorrection = await harness.readOnHand(item.id, topology.defaults.SELLABLE.id);

  const draftCount = await harness.createInventoryCountDraft(
    {
      countedAt: '2026-03-05T00:00:00.000Z',
      warehouseId: topology.warehouse.id,
      locationId: topology.defaults.SELLABLE.id,
      lines: [
        {
          itemId: item.id,
          locationId: topology.defaults.SELLABLE.id,
          uom: 'each',
          countedQuantity: 7,
          reasonCode: 'truth_cycle_count'
        }
      ]
    },
    {
      idempotencyKey: `truth-record-physical-create:${randomUUID()}`
    }
  );

  assert.equal(draftCount.status, 'draft');
  assert.equal(draftCount.inventoryMovementId, null);
  assert.equal(draftCount.lines.length, 1);
  assert.equal(draftCount.lines[0].itemId, item.id);
  assert.equal(draftCount.lines[0].locationId, topology.defaults.SELLABLE.id);
  assert.equal(draftCount.lines[0].countedQuantity, 7);
  assert.equal(draftCount.lines[0].reasonCode, 'truth_cycle_count');
  assert.equal(recordedOnHandBeforeCorrection, 10);
  assert.equal(recordedOnHandBeforeCorrection - draftCount.lines[0].countedQuantity, 3);

  const postedCount = await harness.postInventoryCount(
    draftCount.id,
    `truth-record-physical-post:${randomUUID()}`,
    {
      expectedWarehouseId: topology.warehouse.id,
      actor: { type: 'system', id: null }
    }
  );

  assert.equal(postedCount.status, 'posted');
  assert.ok(postedCount.inventoryMovementId);

  const movementResult = await db.query(
    `SELECT source_type, source_id
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, postedCount.inventoryMovementId]
  );
  assert.equal(movementResult.rowCount, 1);
  assert.equal(movementResult.rows[0]?.source_type, 'cycle_count_post');
  assert.equal(movementResult.rows[0]?.source_id, draftCount.id);

  assert.equal(await harness.readOnHand(item.id, topology.defaults.SELLABLE.id), 7);
  assert.deepEqual(await harness.findQuantityConservationMismatches(), []);
  assert.deepEqual(await harness.findCostLayerConsistencyMismatches(), []);

  const audit = await harness.auditReplayDeterminism(10);
  assert.equal(audit.movementAudit.replayIntegrityFailures.count, 0);
  assert.equal(audit.eventRegistryFailures.count, 0);

  const strict = await harness.runStrictInvariants();
  assert.doesNotMatch(strict.stderr ?? '', /\[strict_failure_summary\]/);
});
