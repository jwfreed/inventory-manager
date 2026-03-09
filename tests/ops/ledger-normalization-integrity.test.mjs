import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from './helpers/service-harness.mjs';
import { insertPostedMovementFixture } from '../helpers/movementFixture.mjs';

function assertAppendOnlyError(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return message.includes('append-only') || message.includes('ledger tables are append-only');
}

async function persistFixtureMovement(harness, suffix) {
  const { tenantId, pool: db, topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: `LEDGER-${suffix}`,
    type: 'raw'
  });
  const movementId = randomUUID();
  const occurredAt = new Date('2026-03-03T00:00:00.000Z');
  const result = await insertPostedMovementFixture(db, {
    id: movementId,
    tenantId,
    movementType: 'adjustment',
    sourceType: 'ledger_normalization_fixture',
    sourceId: movementId,
    externalRef: `ledger-normalization:${suffix}:${movementId}`,
    occurredAt,
    postedAt: occurredAt,
    notes: 'ledger normalization fixture',
    lines: [
      {
        itemId: item.id,
        locationId: topology.defaults.SELLABLE.id,
        quantityDelta: 3,
        uom: 'each',
        quantityDeltaEntered: 3,
        uomEntered: 'each',
        quantityDeltaCanonical: 3,
        canonicalUom: 'each',
        uomDimension: 'count',
        unitCost: 5,
        extendedCost: 15,
        reasonCode: 'ledger_normalization',
        lineNotes: 'fixture line 1',
        createdAt: occurredAt
      },
      {
        itemId: item.id,
        locationId: topology.defaults.QA.id,
        quantityDelta: 2,
        uom: 'each',
        quantityDeltaEntered: 2,
        uomEntered: 'each',
        quantityDeltaCanonical: 2,
        canonicalUom: 'each',
        uomDimension: 'count',
        unitCost: 5,
        extendedCost: 10,
        reasonCode: 'ledger_normalization',
        lineNotes: 'fixture line 2',
        createdAt: occurredAt
      }
    ]
  });
  return { result, movementId, itemId: item.id };
}

test('inventory_movements store deterministic hashes under a NOT NULL schema contract', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'ledger-normalization',
    tenantName: 'Ledger Normalization Tenant'
  });
  const { tenantId, pool: db } = harness;
  const { result, movementId } = await persistFixtureMovement(harness, 'insert');

  assert.equal(result.lineIds.length, 2);
  assert.match(result.movementDeterministicHash ?? '', /^[a-f0-9]{64}$/);

  const schemaResult = await db.query(
    `SELECT is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'inventory_movements'
        AND column_name = 'movement_deterministic_hash'`
  );
  assert.equal(schemaResult.rows[0]?.is_nullable, 'NO');

  const movementResult = await db.query(
    `SELECT movement_deterministic_hash
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, movementId]
  );
  assert.match(
    movementResult.rows[0]?.movement_deterministic_hash ?? '',
    /^[a-f0-9]{64}$/,
    'persisted movement hash must be present'
  );

  const lineCountResult = await db.query(
    `SELECT COUNT(*)::int AS line_count
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2`,
    [tenantId, movementId]
  );
  assert.equal(lineCountResult.rows[0]?.line_count, 2);
});

test('movement_deterministic_hash remains immutable after insert', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'ledger-hash-immutability',
    tenantName: 'Ledger Hash Immutability Tenant'
  });
  const { tenantId, pool: db } = harness;
  const { movementId } = await persistFixtureMovement(harness, 'immutability');

  await assert.rejects(
    db.query(
      `UPDATE inventory_movements
          SET movement_deterministic_hash = $3
        WHERE tenant_id = $1
          AND id = $2`,
      [tenantId, movementId, 'f'.repeat(64)]
    ),
    assertAppendOnlyError
  );
});

test('inventory_movements rejects malformed deterministic hash values at the schema level', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'ledger-hash-format',
    tenantName: 'Ledger Hash Format Tenant'
  });
  const { tenantId, pool: db, topology } = harness;
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'LEDGER-HASH-FORMAT',
    type: 'raw'
  });

  await assert.rejects(
    db.query(
      `INSERT INTO inventory_movements (
          id,
          tenant_id,
          movement_type,
          status,
          external_ref,
          source_type,
          source_id,
          occurred_at,
          posted_at,
          notes,
          metadata,
          movement_deterministic_hash,
          created_at,
          updated_at
       ) VALUES (
          $1, $2, 'adjustment', 'posted', $3, 'ledger_normalization_fixture', $4,
          now(), now(), 'invalid hash fixture', '{}'::jsonb, $5, now(), now()
       )`,
      [randomUUID(), tenantId, `invalid-hash:${item.id}:${randomUUID()}`, randomUUID(), 'not-a-valid-hash']
    ),
    (error) => error?.code === '23514' && error?.constraint === 'chk_inventory_movements_deterministic_hash_format'
  );
});
