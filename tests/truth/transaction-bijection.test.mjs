import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { buildMovementFixtureHash } from '../helpers/movementFixture.mjs';

async function createDraftCount(harness, itemId, locationId, countedQuantity, unitCost) {
  return harness.createInventoryCountDraft(
    {
      countedAt: '2026-03-04T00:00:00.000Z',
      warehouseId: harness.topology.warehouse.id,
      locationId,
      lines: [
        {
          itemId,
          locationId,
          uom: 'each',
          countedQuantity,
          unitCostForPositiveAdjustment: unitCost,
          reasonCode: 'truth_bijection'
        }
      ]
    },
    {
      idempotencyKey: `truth-bijection-create:${randomUUID()}`
    }
  );
}

test('cycle count post maintains an exact 1:1 mapping between domain execution and ledger movement', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-bijection',
    tenantName: 'Truth Transaction Bijection'
  });
  const { tenantId, pool: db, topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'TRUTH-BIJECTION',
    type: 'raw'
  });

  const count = await createDraftCount(harness, item.id, topology.defaults.SELLABLE.id, 6, 4.25);
  const idempotencyKey = `truth-bijection-post:${randomUUID()}`;
  const posted = await harness.postInventoryCount(count.id, idempotencyKey, {
    expectedWarehouseId: topology.warehouse.id,
    actor: { type: 'system', id: null }
  });

  assert.equal(posted.status, 'posted');
  assert.ok(posted.inventoryMovementId);

  const movementResult = await db.query(
    `SELECT id, source_type, source_id, movement_type, idempotency_key
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = 'cycle_count_post'
        AND source_id = $2
        AND movement_type = 'adjustment'`,
    [tenantId, count.id]
  );
  assert.equal(movementResult.rowCount, 1);
  assert.equal(movementResult.rows[0].id, posted.inventoryMovementId);
  assert.equal(
    movementResult.rows[0].idempotency_key,
    `cycle-count-post:${count.id}:${idempotencyKey}`
  );

  const executionResult = await db.query(
    `SELECT status, inventory_movement_id
       FROM cycle_count_post_executions
      WHERE tenant_id = $1
        AND cycle_count_id = $2`,
    [tenantId, count.id]
  );
  assert.equal(executionResult.rowCount, 1);
  assert.equal(executionResult.rows[0].status, 'SUCCEEDED');
  assert.equal(executionResult.rows[0].inventory_movement_id, posted.inventoryMovementId);

  const orphanExecutionResult = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM cycle_count_post_executions
      WHERE tenant_id = $1
        AND cycle_count_id = $2
        AND (status = 'SUCCEEDED' AND inventory_movement_id IS NULL)`,
    [tenantId, count.id]
  );
  assert.equal(Number(orphanExecutionResult.rows[0]?.count ?? 0), 0);

  const orphanMovementResult = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements m
       LEFT JOIN cycle_counts c
         ON c.tenant_id = m.tenant_id
        AND c.id::text = m.source_id
      WHERE m.tenant_id = $1
        AND m.source_type = 'cycle_count_post'
        AND m.source_id = $2
        AND (c.id IS NULL OR c.inventory_movement_id IS DISTINCT FROM m.id)`,
    [tenantId, count.id]
  );
  assert.equal(Number(orphanMovementResult.rows[0]?.count ?? 0), 0);

  const eventResult = await db.query(
    `SELECT aggregate_type, aggregate_id, event_type
       FROM inventory_events
      WHERE tenant_id = $1
        AND (
          (aggregate_type = 'inventory_count' AND aggregate_id = $2)
          OR (aggregate_type = 'inventory_movement' AND aggregate_id = $3)
        )`,
    [tenantId, count.id, posted.inventoryMovementId]
  );
  assert.equal(eventResult.rowCount, 2);
  assert.deepEqual(
    new Set(eventResult.rows.map((row) => `${row.aggregate_type}:${row.event_type}`)),
    new Set([
      'inventory_count:inventory.count.posted',
      'inventory_movement:inventory.movement.posted'
    ])
  );
});

test('cycle count post fails closed when the authoritative movement boundary is incomplete', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-bijection-atomicity',
    tenantName: 'Truth Transaction Atomicity'
  });
  const { tenantId, pool: db, topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'TRUTH-ATOMIC',
    type: 'raw'
  });

  const count = await createDraftCount(harness, item.id, topology.defaults.SELLABLE.id, 2, 8.5);
  const idempotencyKey = `truth-bijection-incomplete:${randomUUID()}`;
  const movementIdempotencyKey = `cycle-count-post:${count.id}:${idempotencyKey}`;
  const incompleteMovementId = randomUUID();
  const occurredAt = count.countedAt;

  await db.query(
    `INSERT INTO inventory_movements (
        id,
        tenant_id,
        movement_type,
        status,
        external_ref,
        source_type,
        source_id,
        idempotency_key,
        occurred_at,
        posted_at,
        notes,
        metadata,
        movement_deterministic_hash,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, 'adjustment', 'posted', $3, 'cycle_count_post', $4, $5, $6, $6, $7, NULL, $8, now(), now()
      )`,
    [
      incompleteMovementId,
      tenantId,
      `cycle_count:${count.id}`,
      count.id,
      movementIdempotencyKey,
      occurredAt,
      'truth incomplete movement shell',
      buildMovementFixtureHash({
        tenantId,
        movementType: 'adjustment',
        occurredAt,
        sourceType: 'cycle_count_post',
        sourceId: count.id,
        lines: []
      })
    ]
  );

  await assert.rejects(
    harness.postInventoryCount(count.id, idempotencyKey, {
      expectedWarehouseId: topology.warehouse.id,
      actor: { type: 'system', id: null }
    }),
    (error) => {
      assert.equal(error?.code ?? error?.message, 'INV_COUNT_POST_IDEMPOTENCY_INCOMPLETE');
      assert.equal(error?.details?.reason, 'movement_exists_without_lines');
      return true;
    }
  );

  const reloadedCount = await harness.getInventoryCount(count.id);
  assert.equal(reloadedCount?.status, 'draft');
  assert.equal(reloadedCount?.inventoryMovementId, null);

  const executionResult = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM cycle_count_post_executions
      WHERE tenant_id = $1
        AND cycle_count_id = $2
        AND idempotency_key = $3`,
    [tenantId, count.id, idempotencyKey]
  );
  assert.equal(Number(executionResult.rows[0]?.count ?? 0), 0);

  const idempotencyRowResult = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM idempotency_keys
      WHERE tenant_id = $1
        AND key = $2`,
    [tenantId, idempotencyKey]
  );
  assert.equal(Number(idempotencyRowResult.rows[0]?.count ?? 0), 0);

  const movementResult = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = 'cycle_count_post'
        AND source_id = $2`,
    [tenantId, count.id]
  );
  assert.equal(Number(movementResult.rows[0]?.count ?? 0), 1);

  const movementLineResult = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2`,
    [tenantId, incompleteMovementId]
  );
  assert.equal(Number(movementLineResult.rows[0]?.count ?? 0), 0);
});
