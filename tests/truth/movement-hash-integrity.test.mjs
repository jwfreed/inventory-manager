import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { insertPostedMovementFixture } from '../helpers/movementFixture.mjs';

const FIXED_OCCURRED_AT = '2026-03-02T00:00:00.000Z';
const TAMPERED_HASH = 'f'.repeat(64);

test('movement hash integrity fails closed after authoritative hash tampering', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-movement-hash-integrity',
    tenantName: 'Truth Movement Hash Integrity'
  });
  const { tenantId, pool: db, topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'TRUTH-HASH',
    type: 'raw'
  });

  const movementId = randomUUID();
  await insertPostedMovementFixture(db, {
    id: movementId,
    tenantId,
    movementType: 'receive',
    sourceType: 'truth_hash_fixture',
    sourceId: randomUUID(),
    externalRef: 'truth-hash:fixture-1',
    occurredAt: FIXED_OCCURRED_AT,
    lines: [
      {
        itemId: item.id,
        locationId: topology.defaults.SELLABLE.id,
        quantityDelta: 5,
        uom: 'each',
        quantityDeltaEntered: 5,
        uomEntered: 'each',
        quantityDeltaCanonical: 5,
        canonicalUom: 'each',
        uomDimension: 'count',
        unitCost: 2,
        extendedCost: 10,
        reasonCode: 'truth_hash_fixture'
      }
    ]
  });

  const cleanAudit = await harness.auditReplayDeterminism(10);
  assert.equal(cleanAudit.movementAudit.totalMovements, 1);
  assert.equal(cleanAudit.movementAudit.rowsMissingDeterministicHash, 0);
  assert.equal(cleanAudit.movementAudit.postCutoffRowsMissingHash, 0);
  assert.equal(cleanAudit.movementAudit.replayIntegrityFailures.count, 0);
  assert.equal(cleanAudit.eventRegistryFailures.count, 0);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(
      `UPDATE inventory_movements
          SET movement_deterministic_hash = $1,
              updated_at = now()
        WHERE tenant_id = $2
          AND id = $3`,
      [TAMPERED_HASH, tenantId, movementId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const tamperedAudit = await harness.auditReplayDeterminism(10);
  assert.equal(tamperedAudit.movementAudit.totalMovements, 1);
  assert.equal(tamperedAudit.movementAudit.rowsMissingDeterministicHash, 0);
  assert.equal(tamperedAudit.movementAudit.postCutoffRowsMissingHash, 0);
  assert.equal(tamperedAudit.movementAudit.replayIntegrityFailures.count, 1);
  assert.equal(tamperedAudit.movementAudit.replayIntegrityFailures.sample.length, 1);
  assert.equal(tamperedAudit.movementAudit.replayIntegrityFailures.sample[0].movementId, movementId);
  assert.equal(
    tamperedAudit.movementAudit.replayIntegrityFailures.sample[0].reason,
    'authoritative_movement_hash_mismatch'
  );
  assert.equal(tamperedAudit.eventRegistryFailures.count, 0);
});
