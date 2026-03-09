import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServiceHarness } from './helpers/service-harness.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  auditMovementHashCoverage,
  buildPostedDocumentReplayResult
} = require('../../src/modules/platform/application/inventoryMutationSupport.ts');

const FIXED_OCCURRED_AT = new Date('2026-03-02T00:00:00.000Z');

async function insertMovementFixture(params) {
  const {
    db,
    tenantId,
    itemId,
    locationId,
    externalRef,
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
        occurred_at,
        posted_at,
        notes,
        movement_deterministic_hash,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, 'receive', 'posted', $3, 'audit_fixture', $4, $5, $5, 'audit fixture', $6, $5, $5
      )`,
    [movementId, tenantId, externalRef, movementId, FIXED_OCCURRED_AT, movementHash ?? null]
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
      ) VALUES (
        $1, $2, $3, $4, $5, 5, 'each', 5, 'each', 5, 'each', 'count', 2, 10, 'audit_receive', 'audit fixture', $6
      )`,
    [randomUUID(), tenantId, movementId, itemId, locationId, FIXED_OCCURRED_AT]
  );
  return movementId;
}

test('auditMovementHashCoverage reports universal hash gaps and replay failures without transitional tolerances', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'movement-hash-audit',
    tenantName: 'Movement Hash Audit Tenant'
  });
  const { tenantId, pool: db, topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'AUDIT-ITEM',
    type: 'raw'
  });

  await insertMovementFixture({
    db,
    tenantId,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    externalRef: `mismatch-hash:${randomUUID()}`,
    movementHash: '0'.repeat(64)
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 11,
    unitCost: 5
  });

  const audit = await auditMovementHashCoverage(db, {
    tenantId,
    sampleLimit: 5
  });

  assert.ok(audit.totalMovements >= 2);
  assert.equal(audit.rowsMissingDeterministicHash, 0);
  assert.equal(audit.postCutoffRowsMissingHash, 0);
  assert.equal(audit.replayIntegrityFailures.count, 1);
  assert.deepEqual(
    new Set(audit.replayIntegrityFailures.sample.map((failure) => failure.reason)),
    new Set(['authoritative_movement_hash_mismatch'])
  );
});

test('inventory_movements rejects NULL deterministic hashes at schema level', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'movement-hash-not-null',
    tenantName: 'Movement Hash Not Null Tenant'
  });
  const { tenantId, pool: db } = harness;
  const movementId = randomUUID();

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
          movement_deterministic_hash,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, 'receive', 'posted', $3, 'audit_fixture', $4, $5, $5, 'audit fixture', NULL, $5, $5
        )`,
      [movementId, tenantId, `missing-hash:${movementId}`, movementId, FIXED_OCCURRED_AT]
    ),
    (error) => {
      assert.equal(error?.code, '23502');
      return true;
    }
  );
});

test('shared replay helper still fails closed if a persisted movement hash is missing', async () => {
  const fakeClient = {
    async query(sql) {
      if (typeof sql === 'string' && sql.includes('movement_deterministic_hash')) {
        return {
          rowCount: 1,
          rows: [
            {
              created_at: FIXED_OCCURRED_AT,
              movement_type: 'receive',
              occurred_at: FIXED_OCCURRED_AT,
              source_type: 'audit_fixture',
              source_id: 'fixture-source',
              movement_deterministic_hash: null
            }
          ]
        };
      }
      if (typeof sql === 'string' && sql.includes('FROM inventory_movement_lines')) {
        return {
          rowCount: 1,
          rows: [
            {
              itemId: 'item-1',
              locationId: 'location-1',
              quantityDelta: 5,
              uom: 'each',
              canonicalUom: 'each',
              unitCost: 2,
              reasonCode: 'audit_receive'
            }
          ]
        };
      }
      if (typeof sql === 'string' && sql.includes('FROM inventory_events')) {
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    }
  };

  await assert.rejects(
    buildPostedDocumentReplayResult({
      tenantId: 'tenant-1',
      authoritativeMovements: [
        {
          movementId: 'movement-1',
          expectedLineCount: 1
        }
      ],
      client: fakeClient,
      fetchAggregateView: async () => ({ ok: true }),
      aggregateNotFoundError: new Error('AGGREGATE_NOT_FOUND'),
      authoritativeEvents: []
    }),
    (error) => {
      assert.equal(error?.code, 'REPLAY_CORRUPTION_DETECTED');
      assert.equal(error?.details?.reason, 'authoritative_movement_hash_missing');
      return true;
    }
  );
});
