import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { insertPostedMovementFixture } from '../helpers/movementFixture.mjs';

function assertAppendOnlyError(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return message.includes('append-only') || message.includes('ledger tables are append-only');
}

test('ledger tables reject UPDATE and DELETE against authoritative movement rows', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-ledger-immutability',
    tenantName: 'Truth Ledger Immutability'
  });
  const { tenantId, pool: db, topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'IMMUTABLE',
    type: 'raw'
  });

  const movementId = randomUUID();
  const lineId = randomUUID();
  await insertPostedMovementFixture(db, {
    id: movementId,
    tenantId,
    movementType: 'adjustment',
    sourceType: 'truth_fixture',
    sourceId: randomUUID(),
    externalRef: `truth-ledger:${movementId}`,
    notes: 'truth ledger immutability fixture',
    lines: [
      {
        id: lineId,
        itemId: item.id,
        locationId: topology.defaults.SELLABLE.id,
        quantityDelta: 1,
        uom: 'each',
        quantityDeltaEntered: 1,
        uomEntered: 'each',
        quantityDeltaCanonical: 1,
        canonicalUom: 'each',
        uomDimension: 'count',
        unitCost: 0,
        extendedCost: 0,
        reasonCode: 'truth_fixture',
        lineNotes: 'truth fixture line'
      }
    ]
  });

  await assert.rejects(
    db.query(
      `UPDATE inventory_movements
          SET notes = notes
        WHERE tenant_id = $1
          AND id = $2`,
      [tenantId, movementId]
    ),
    assertAppendOnlyError
  );

  await assert.rejects(
    db.query(
      `DELETE FROM inventory_movements
        WHERE tenant_id = $1
          AND id = $2`,
      [tenantId, movementId]
    ),
    assertAppendOnlyError
  );

  await assert.rejects(
    db.query(
      `UPDATE inventory_movement_lines
          SET quantity_delta = quantity_delta
        WHERE tenant_id = $1
          AND id = $2`,
      [tenantId, lineId]
    ),
    assertAppendOnlyError
  );
});
