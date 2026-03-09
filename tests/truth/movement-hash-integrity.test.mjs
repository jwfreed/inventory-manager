import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { insertPostedMovementFixture } from '../helpers/movementFixture.mjs';

test('movement hash audit fails closed on authoritative hash tampering', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-movement-hash',
    tenantName: 'Truth Movement Hash'
  });
  const { tenantId, pool: db, topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'HASH',
    type: 'raw'
  });

  const movementId = randomUUID();
  await insertPostedMovementFixture(db, {
    id: movementId,
    tenantId,
    movementType: 'receive',
    sourceType: 'truth_hash_fixture',
    sourceId: movementId,
    externalRef: `truth-hash:${movementId}`,
    occurredAt: '2026-03-02T00:00:00.000Z',
    movementDeterministicHash: '0'.repeat(64),
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

  const audit = await harness.auditReplayDeterminism(10);
  assert.equal(audit.movementAudit.rowsMissingDeterministicHash, 0);
  assert.equal(audit.movementAudit.replayIntegrityFailures.count, 1);
  assert.deepEqual(
    new Set(audit.movementAudit.replayIntegrityFailures.sample.map((entry) => entry.reason)),
    new Set(['authoritative_movement_hash_mismatch'])
  );
});
