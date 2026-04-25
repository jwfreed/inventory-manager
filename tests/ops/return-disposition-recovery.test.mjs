import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { insertPostedMovementFixture } from '../helpers/movementFixture.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  createReturnAuthorization
} = require('../../src/services/orderToCash.service.ts');
const {
  createReturnReceipt,
  createReturnDisposition,
  postReturnDisposition,
  postReturnReceipt
} = require('../../src/services/returnsExtended.service.ts');
const {
  buildMovementDeterministicHash
} = require('../../src/modules/platform/application/inventoryMutationSupport.ts');

async function createPostedDispositionFixture(prefix) {
  const harness = await createServiceHarness({
    tenantPrefix: prefix,
    tenantName: `${prefix} tenant`
  });
  const { topology } = harness;
  const customer = await harness.createCustomer(prefix.toUpperCase());
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.HOLD.id,
    skuPrefix: prefix.toUpperCase(),
    type: 'raw'
  });

  const authorization = await createReturnAuthorization(harness.tenantId, {
    rmaNumber: `RMA-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'authorized',
    authorizedAt: '2026-03-17T00:00:00.000Z',
    lines: [{
      itemId: item.id,
      uom: 'each',
      quantityAuthorized: 2
    }]
  });

  const receipt = await createReturnReceipt(harness.tenantId, {
    returnAuthorizationId: authorization.id,
    receivedAt: '2026-03-18T00:00:00.000Z',
    receivedToLocationId: topology.defaults.HOLD.id,
    lines: [{
      returnAuthorizationLineId: authorization.lines[0].id,
      itemId: item.id,
      uom: 'each',
      quantityReceived: 2
    }]
  });
  const postedReceipt = await postReturnReceipt(harness.tenantId, receipt.id, {
    idempotencyKey: `return-receipt-post:${randomUUID()}`
  });

  const disposition = await createReturnDisposition(harness.tenantId, {
    returnReceiptId: receipt.id,
    occurredAt: '2026-03-19T00:00:00.000Z',
    dispositionType: 'restock',
    fromLocationId: topology.defaults.HOLD.id,
    toLocationId: topology.defaults.SELLABLE.id,
    lines: [{
      lineNumber: 1,
      itemId: item.id,
      uom: 'each',
      quantity: 2
    }]
  });

  return { harness, topology, item, postedReceipt, disposition };
}

test('return disposition retry repairs a recoverable partial document state without duplicating movements', async () => {
  const { harness, disposition } = await createPostedDispositionFixture('return-disp-partial');
  const firstPost = await postReturnDisposition(harness.tenantId, disposition.id, {
    idempotencyKey: `return-disposition-post:${randomUUID()}`
  });

  await harness.pool.query(
    `UPDATE return_dispositions
        SET status = 'draft',
            inventory_movement_id = NULL
      WHERE tenant_id = $1
        AND id = $2`,
    [harness.tenantId, disposition.id]
  );

  const repaired = await postReturnDisposition(harness.tenantId, disposition.id, {
    idempotencyKey: `return-disposition-post:${randomUUID()}`
  });

  assert.equal(repaired.status, 'posted');
  assert.equal(repaired.inventoryMovementId, firstPost.inventoryMovementId);

  const movementCount = await harness.pool.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = 'return_disposition_post'
        AND source_id = $2`,
    [harness.tenantId, disposition.id]
  );
  assert.equal(Number(movementCount.rows[0]?.count ?? 0), 1);
});

test('return disposition retry tolerates linkage drift by repairing the document pointer to the authoritative movement', async () => {
  const { harness, postedReceipt, disposition } = await createPostedDispositionFixture('return-disp-drift');
  const firstPost = await postReturnDisposition(harness.tenantId, disposition.id, {
    idempotencyKey: `return-disposition-post:${randomUUID()}`
  });

  await harness.pool.query(
    `UPDATE return_dispositions
        SET inventory_movement_id = $1
      WHERE tenant_id = $2
        AND id = $3`,
    [postedReceipt.inventoryMovementId, harness.tenantId, disposition.id]
  );

  const repaired = await postReturnDisposition(harness.tenantId, disposition.id, {
    idempotencyKey: `return-disposition-post:${randomUUID()}`
  });

  assert.equal(repaired.inventoryMovementId, firstPost.inventoryMovementId);

  const persisted = await harness.pool.query(
    `SELECT inventory_movement_id
       FROM return_dispositions
      WHERE tenant_id = $1
        AND id = $2`,
    [harness.tenantId, disposition.id]
  );
  assert.equal(persisted.rows[0]?.inventory_movement_id, firstPost.inventoryMovementId);
});

test('return disposition retry fails closed when authoritative movement state is irrecoverably corrupted', async () => {
  const { harness, disposition } = await createPostedDispositionFixture('return-disp-irrec');
  const firstPost = await postReturnDisposition(harness.tenantId, disposition.id, {
    idempotencyKey: `return-disposition-post:${randomUUID()}`
  });

  const movementLineResult = await harness.pool.query(
    `SELECT item_id,
            location_id,
            quantity_delta,
            canonical_uom,
            unit_cost
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
        AND quantity_delta > 0
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [harness.tenantId, firstPost.inventoryMovementId]
  );
  assert.equal(movementLineResult.rowCount, 1);
  const movementLine = movementLineResult.rows[0];
  const ambiguousMovementId = randomUUID();
  const ambiguousHash = buildMovementDeterministicHash({
    tenantId: harness.tenantId,
    movementType: 'receive',
    occurredAt: '2026-03-19T00:00:00.000Z',
    sourceType: 'return_disposition_post',
    sourceId: disposition.id,
    lines: [{
      itemId: movementLine.item_id,
      locationId: movementLine.location_id,
      quantityDelta: movementLine.quantity_delta,
      canonicalUom: movementLine.canonical_uom,
      unitCost: movementLine.unit_cost,
      reasonCode: 'return_disposition_corruption'
    }]
  });

  await insertPostedMovementFixture(harness.pool, {
    id: ambiguousMovementId,
    tenantId: harness.tenantId,
    movementType: 'receive',
    sourceType: 'return_disposition_post',
    sourceId: disposition.id,
    externalRef: `corrupt:${ambiguousMovementId}`,
    occurredAt: '2026-03-19T00:00:00.000Z',
    postedAt: '2026-03-19T00:00:00.000Z',
    notes: 'Ambiguous authoritative movement',
    movementDeterministicHash: ambiguousHash,
    lines: [
      {
        id: randomUUID(),
        sourceLineId: 'return-disposition-corruption-line',
        itemId: movementLine.item_id,
        locationId: movementLine.location_id,
        quantityDelta: Number(movementLine.quantity_delta),
        uom: movementLine.canonical_uom,
        quantityDeltaEntered: Number(movementLine.quantity_delta),
        uomEntered: movementLine.canonical_uom,
        quantityDeltaCanonical: Number(movementLine.quantity_delta),
        canonicalUom: movementLine.canonical_uom,
        uomDimension: 'count',
        unitCost: Number(movementLine.unit_cost ?? 0),
        extendedCost: Number(movementLine.quantity_delta) * Number(movementLine.unit_cost ?? 0),
        reasonCode: 'return_disposition_corruption',
        lineNotes: 'Ambiguous authoritative movement line',
        createdAt: '2026-03-19T00:00:00.000Z'
      }
    ]
  });

  await assert.rejects(
    () =>
      postReturnDisposition(harness.tenantId, disposition.id, {
        idempotencyKey: `return-disposition-post:${randomUUID()}`
      }),
    (error) =>
      error?.code === 'RETURN_DISPOSITION_RECOVERY_IRRECOVERABLE'
      || error?.message === 'RETURN_DISPOSITION_RECOVERY_IRRECOVERABLE'
  );

  const movementCount = await harness.pool.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = 'return_disposition_post'
        AND source_id = $2`,
    [harness.tenantId, disposition.id]
  );
  assert.equal(Number(movementCount.rows[0]?.count ?? 0), 2);
});
