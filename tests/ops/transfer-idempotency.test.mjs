import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServiceHarness } from './helpers/service-harness.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const FIXED_OCCURRED_AT = new Date('2026-03-01T00:00:00.000Z');

async function createTransferFixture(label) {
  const harness = await createServiceHarness({
    tenantPrefix: label,
    tenantName: `Transfer ${label}`
  });
  const factory = harness.topology;
  const store = await harness.createWarehouseWithSellable(`STORE-${randomUUID().slice(0, 6)}`);
  const item = await harness.createItem({
    defaultLocationId: factory.defaults.SELLABLE.id,
    skuPrefix: 'ITEM',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: factory.warehouse.id,
    itemId: item.id,
    locationId: factory.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });
  return {
    harness,
    factory,
    store,
    itemId: item.id
  };
}

async function expectServiceError(action, expectedCode, expectedReason = null) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.code ?? error?.message, expectedCode);
    if (expectedReason) {
      assert.equal(error?.details?.reason, expectedReason);
    }
    return true;
  });
}

async function retargetTransferReplayMovement(db, tenantId, idempotencyKey, movementId) {
  await db.query(
    `UPDATE idempotency_keys
        SET response_body = jsonb_set(
              jsonb_set(response_body, '{movementId}', to_jsonb($3::text), true),
              '{transferId}',
              to_jsonb($3::text),
              true
            ),
            updated_at = now()
      WHERE tenant_id = $1
        AND key = $2`,
    [tenantId, idempotencyKey, movementId]
  );
}

async function insertTransferReplayFixture(params) {
  const {
    db,
    tenantId,
    itemId,
    sourceLocationId,
    destinationLocationId,
    occurredAt = FIXED_OCCURRED_AT,
    movementHash
  } = params;
  const movementId = randomUUID();
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
        movement_deterministic_hash,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, 'adjustment', 'posted', $3, 'transfer_fixture', $4, NULL, $5, $5, 'fixture', $6, $5, $5
      )`,
    [movementId, tenantId, `fixture:${movementId}`, movementId, occurredAt, movementHash ?? null]
  );
  await db.query(
    `INSERT INTO inventory_movement_lines (
        id,
        tenant_id,
        movement_id,
        item_id,
        location_id,
        quantity_delta,
        uom,
        quantity_delta_entered,
        uom_entered,
        quantity_delta_canonical,
        canonical_uom,
        uom_dimension,
        unit_cost,
        extended_cost,
        reason_code,
        line_notes,
        created_at
      ) VALUES
      ($1, $2, $3, $4, $5, -2, 'each', -2, 'each', -2, 'each', 'count', 0, 0, 'fixture_out', 'fixture', $7),
      ($6, $2, $3, $4, $8, 2, 'each', 2, 'each', 2, 'each', 'count', 0, 0, 'fixture_in', 'fixture', $7)`,
    [
      randomUUID(),
      tenantId,
      movementId,
      itemId,
      sourceLocationId,
      randomUUID(),
      occurredAt,
      destinationLocationId
    ]
  );
  return movementId;
}

async function insertBalancedTransferLineCorruption(params) {
  const {
    db,
    tenantId,
    movementId,
    itemId,
    sourceLocationId,
    destinationLocationId
  } = params;
  const outLineId = randomUUID();
  const inLineId = randomUUID();
  const sourceLayerId = randomUUID();
  const destLayerId = randomUUID();
  const linkId = randomUUID();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO inventory_movement_lines (
          id,
          tenant_id,
          movement_id,
          item_id,
          location_id,
          quantity_delta,
          uom,
          quantity_delta_entered,
          uom_entered,
          quantity_delta_canonical,
          canonical_uom,
          uom_dimension,
          unit_cost,
          extended_cost,
          reason_code,
          line_notes,
          created_at
        ) VALUES
        ($1, $2, $3, $4, $5, -1, 'each', -1, 'each', -1, 'each', 'count', 0, 0, 'tamper_out', 'tamper', now()),
        ($6, $2, $3, $4, $7, 1, 'each', 1, 'each', 1, 'each', 'count', 0, 0, 'tamper_in', 'tamper', now())`,
      [
        outLineId,
        tenantId,
        movementId,
        itemId,
        sourceLocationId,
        inLineId,
        destinationLocationId
      ]
    );
    await client.query(
      `INSERT INTO inventory_cost_layers (
          id,
          tenant_id,
          item_id,
          location_id,
          uom,
          layer_date,
          layer_sequence,
          original_quantity,
          remaining_quantity,
          unit_cost,
          extended_cost,
          source_type,
          notes,
          created_at,
          updated_at
        ) VALUES
        ($1, $2, $3, $4, 'each', now(), 1, 1, 1, 0, 0, 'opening_balance', 'tamper source', now(), now()),
        ($5, $2, $3, $6, 'each', now(), 1, 1, 1, 0, 0, 'opening_balance', 'tamper dest', now(), now())`,
      [sourceLayerId, tenantId, itemId, sourceLocationId, destLayerId, destinationLocationId]
    );
    await client.query(
      `INSERT INTO cost_layer_transfer_links (
          id,
          tenant_id,
          transfer_movement_id,
          transfer_out_line_id,
          transfer_in_line_id,
          source_cost_layer_id,
          dest_cost_layer_id,
          quantity,
          unit_cost,
          extended_cost,
          created_at
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          1,
          0,
          0,
          now()
        )`,
      [linkId, tenantId, movementId, outLineId, inLineId, sourceLayerId, destLayerId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

test('inventory transfer idempotency: replay and payload conflict stay deterministic without HTTP', async () => {
  const { harness, factory, store, itemId } = await createTransferFixture('transfer-idempotency');
  const { pool: db, tenantId } = harness;

  const payload = {
    sourceLocationId: factory.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId,
    quantity: 3,
    uom: 'each',
    reasonCode: 'distribution',
    notes: 'Transfer idempotency test'
  };
  const idempotencyKey = `transfer-idem-${randomUUID()}`;

  const first = await harness.postTransfer({
    ...payload,
    idempotencyKey
  });
  assert.ok(first.movementId);
  assert.equal(first.transferId, first.movementId);
  assert.equal(first.idempotencyKey, idempotencyKey);
  assert.equal(first.replayed, false);

  const movementHashRes = await db.query(
    `SELECT movement_deterministic_hash
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, first.movementId]
  );
  assert.equal(movementHashRes.rowCount, 1);
  assert.ok(movementHashRes.rows[0]?.movement_deterministic_hash, 'transfer movement hash must persist');

  const transferEventRes = await db.query(
    `SELECT aggregate_type, aggregate_id, event_type, event_version
       FROM inventory_events
      WHERE tenant_id = $1
        AND aggregate_id = $2
        AND aggregate_type IN ('inventory_transfer', 'inventory_movement')
      ORDER BY aggregate_type ASC, event_type ASC`,
    [tenantId, first.movementId]
  );
  assert.deepEqual(
    transferEventRes.rows.map((row) => `${row.aggregate_type}:${row.event_type}:v${row.event_version}`),
    [
      'inventory_movement:inventory.movement.posted:v1',
      'inventory_transfer:inventory.transfer.created:v1',
      'inventory_transfer:inventory.transfer.issued:v1',
      'inventory_transfer:inventory.transfer.received:v1'
    ]
  );

  await assert.rejects(
    db.query(
      `INSERT INTO inventory_events (
          event_id,
          tenant_id,
          aggregate_type,
          aggregate_id,
          event_type,
          event_version,
          payload,
          created_at,
          producer_idempotency_key
       ) VALUES ($1, $2, 'inventory_transfer', $3, 'inventory.transfer.created', 1, $4::jsonb, now(), NULL)`,
      [
        randomUUID(),
        tenantId,
        first.movementId,
        JSON.stringify({ transferId: first.movementId, movementId: first.movementId })
      ]
    ),
    (error) => error?.code === '23505'
  );

  const replay = await harness.postTransfer({
    ...payload,
    idempotencyKey
  });
  assert.equal(replay.movementId, first.movementId);
  assert.equal(replay.transferId, first.movementId);
  assert.equal(replay.idempotencyKey, idempotencyKey);
  assert.equal(replay.replayed, true);

  const movementCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = 'inventory_transfer'
        AND source_id = $2`,
    [tenantId, `idempotency:${idempotencyKey}`]
  );
  assert.equal(Number(movementCount.rows[0]?.count ?? 0), 1);

  await expectServiceError(
    () =>
      harness.postTransfer({
        ...payload,
        warehouseId: factory.warehouse.id,
        idempotencyKey: `transfer-idem-mismatch-${randomUUID()}`
      }),
    'WAREHOUSE_SCOPE_MISMATCH'
  );

  await expectServiceError(
    () =>
      harness.postTransfer({
        ...payload,
        quantity: 4,
        idempotencyKey
      }),
    'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD'
  );
});

test('inventory transfer replay fails closed when the idempotent response points to a missing movement', async () => {
  const { harness, factory, store, itemId } = await createTransferFixture('transfer-missing');
  const { pool: db, tenantId } = harness;
  const idempotencyKey = `transfer-missing-${randomUUID()}`;

  const first = await harness.postTransfer({
    sourceLocationId: factory.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId,
    quantity: 2,
    uom: 'each',
    reasonCode: 'distribution',
    notes: 'Transfer replay missing movement',
    idempotencyKey
  });

  await retargetTransferReplayMovement(db, tenantId, idempotencyKey, randomUUID());

  await expectServiceError(
    () =>
      harness.postTransfer({
        sourceLocationId: factory.defaults.SELLABLE.id,
        destinationLocationId: store.sellable.id,
        itemId,
        quantity: 2,
        uom: 'each',
        reasonCode: 'distribution',
        notes: 'Transfer replay missing movement',
        idempotencyKey
      }),
    'REPLAY_CORRUPTION_DETECTED',
    'authoritative_movement_missing'
  );

  assert.ok(first.movementId);
});

test('inventory transfer replay fails closed when authoritative movement lines drift', async () => {
  const { harness, factory, store, itemId } = await createTransferFixture('transfer-drift');
  const { pool: db, tenantId } = harness;
  const idempotencyKey = `transfer-corruption-${randomUUID()}`;

  const first = await harness.postTransfer({
    sourceLocationId: factory.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId,
    quantity: 2,
    uom: 'each',
    reasonCode: 'distribution',
    notes: 'Transfer replay corruption test',
    idempotencyKey,
    occurredAt: FIXED_OCCURRED_AT
  });

  await insertBalancedTransferLineCorruption({
    db,
    tenantId,
    movementId: first.movementId,
    itemId,
    sourceLocationId: factory.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id
  });

  await expectServiceError(
    () =>
      harness.postTransfer({
        sourceLocationId: factory.defaults.SELLABLE.id,
        destinationLocationId: store.sellable.id,
        itemId,
        quantity: 2,
        uom: 'each',
        reasonCode: 'distribution',
        notes: 'Transfer replay corruption test',
        idempotencyKey,
        occurredAt: FIXED_OCCURRED_AT
      }),
    'REPLAY_CORRUPTION_DETECTED',
    'authoritative_movement_line_count_mismatch'
  );
});

test('inventory transfer schema rejects missing hashes and replay fails closed on mismatches', async () => {
  const { harness, factory, store, itemId } = await createTransferFixture('transfer-hash');
  const { pool: db, tenantId } = harness;
  const basePayload = {
    sourceLocationId: factory.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId,
    quantity: 2,
    uom: 'each',
    reasonCode: 'distribution',
    notes: 'Transfer replay hash test'
  };

  await assert.rejects(
    insertTransferReplayFixture({
      db,
      tenantId,
      itemId,
      sourceLocationId: factory.defaults.SELLABLE.id,
      destinationLocationId: store.sellable.id,
      occurredAt: FIXED_OCCURRED_AT,
      movementHash: null
    }),
    (error) => {
      assert.equal(error?.code, '23502');
      return true;
    }
  );

  const mismatchHashKey = `transfer-hash-mismatch-${randomUUID()}`;
  await harness.postTransfer({
    ...basePayload,
    idempotencyKey: mismatchHashKey,
    occurredAt: FIXED_OCCURRED_AT
  });
  const mismatchHashFixtureId = await insertTransferReplayFixture({
    db,
    tenantId,
    itemId,
    sourceLocationId: factory.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    occurredAt: FIXED_OCCURRED_AT,
    movementHash: '0'.repeat(64)
  });
  await retargetTransferReplayMovement(db, tenantId, mismatchHashKey, mismatchHashFixtureId);
  await expectServiceError(
    () =>
      harness.postTransfer({
        ...basePayload,
        occurredAt: FIXED_OCCURRED_AT,
        idempotencyKey: mismatchHashKey
      }),
    'REPLAY_CORRUPTION_DETECTED',
    'authoritative_movement_hash_mismatch'
  );
});

test('inventory transfer replay fails closed when a persisted event violates the registry contract', async () => {
  const { harness, factory, store, itemId } = await createTransferFixture('transfer-event');
  const { pool: db, tenantId } = harness;
  const idempotencyKey = `transfer-event-${randomUUID()}`;

  const first = await harness.postTransfer({
    sourceLocationId: factory.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId,
    quantity: 2,
    uom: 'each',
    reasonCode: 'distribution',
    notes: 'Transfer replay event mismatch',
    idempotencyKey
  });

  await db.query(
    `UPDATE inventory_events
        SET payload = '{}'::jsonb
      WHERE tenant_id = $1
        AND aggregate_type = 'inventory_movement'
        AND aggregate_id = $2
        AND event_type = 'inventory.movement.posted'
        AND event_version = 1`,
    [tenantId, first.movementId]
  );

  await expectServiceError(
    () =>
      harness.postTransfer({
        sourceLocationId: factory.defaults.SELLABLE.id,
        destinationLocationId: store.sellable.id,
        itemId,
        quantity: 2,
        uom: 'each',
        reasonCode: 'distribution',
        notes: 'Transfer replay event mismatch',
        idempotencyKey
      }),
    'REPLAY_CORRUPTION_DETECTED',
    'inventory_event_registry_contract_violation'
  );
});
