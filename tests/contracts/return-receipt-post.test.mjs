import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { assertMovementContract } from './helpers/mutationContract.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  createReturnAuthorization
} = require('../../src/services/orderToCash.service.ts');
const {
  createReturnReceipt,
  getReturnReceipt,
  postReturnReceipt
} = require('../../src/services/returnsExtended.service.ts');
const {
  buildMovementDeterministicHash
} = require('../../src/modules/platform/application/inventoryMutationSupport.ts');

async function createPostedReturnReceiptFixture(harness, options = {}) {
  const { topology } = harness;
  const customer = await harness.createCustomer(options.customerPrefix ?? 'RET-FIX');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.HOLD.id,
    skuPrefix: options.skuPrefix ?? 'RET-FIX',
    type: 'raw'
  });

  const authorization = await createReturnAuthorization(harness.tenantId, {
    rmaNumber: `RMA-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'authorized',
    authorizedAt: options.authorizedAt ?? '2026-03-05T00:00:00.000Z',
    lines: [{
      itemId: item.id,
      uom: 'each',
      quantityAuthorized: options.quantityAuthorized ?? 1
    }]
  });

  const receipt = await createReturnReceipt(harness.tenantId, {
    returnAuthorizationId: authorization.id,
    receivedAt: options.receivedAt ?? '2026-03-06T00:00:00.000Z',
    receivedToLocationId: topology.defaults.HOLD.id,
    lines: [{
      returnAuthorizationLineId: authorization.lines[0].id,
      itemId: item.id,
      uom: 'each',
      quantityReceived: options.quantityReceived ?? 1
    }]
  });

  const postedReceipt = await postReturnReceipt(harness.tenantId, receipt.id, {
    idempotencyKey: `return-receipt-post:${randomUUID()}`
  });

  return {
    topology,
    customer,
    item,
    authorization,
    receipt: postedReceipt
  };
}

test('return receipt creation remains draft-only and posting creates the authoritative receive movement', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-return-receipt',
    tenantName: 'Return Receipt Contract Tenant'
  });
  const { topology } = harness;
  const customer = await harness.createCustomer('RET');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.HOLD.id,
    skuPrefix: 'RET',
    type: 'raw'
  });

  const authorization = await createReturnAuthorization(harness.tenantId, {
    rmaNumber: `RMA-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'authorized',
    authorizedAt: '2026-03-05T00:00:00.000Z',
    lines: [{
      itemId: item.id,
      uom: 'each',
      quantityAuthorized: 2
    }]
  });

  const createdReceipt = await createReturnReceipt(harness.tenantId, {
    returnAuthorizationId: authorization.id,
    status: 'posted',
    receivedAt: '2026-03-06T00:00:00.000Z',
    receivedToLocationId: topology.defaults.HOLD.id,
    inventoryMovementId: randomUUID(),
    lines: [{
      returnAuthorizationLineId: authorization.lines[0].id,
      itemId: item.id,
      uom: 'each',
      quantityReceived: 2
    }]
  });

  assert.equal(createdReceipt.status, 'draft');
  assert.equal(createdReceipt.inventoryMovementId, null);

  const postedReceipt = await postReturnReceipt(harness.tenantId, createdReceipt.id, {
    idempotencyKey: `return-receipt-post:${randomUUID()}`
  });
  assert.equal(postedReceipt.status, 'posted');
  assert.ok(postedReceipt.inventoryMovementId);

  await assertMovementContract({
    harness,
    movementId: postedReceipt.inventoryMovementId,
    expectedMovementType: 'receive',
    expectedSourceType: 'return_receipt_post',
    expectedLineCount: 1,
    expectedBalances: [{
      itemId: item.id,
      locationId: topology.defaults.HOLD.id,
      onHand: 2
    }]
  });

  const receiptLineId = postedReceipt.lines[0].id;
  const costLayerResult = await harness.pool.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND source_type = 'receipt'
        AND source_document_id = $2
        AND movement_id = $3`,
    [harness.tenantId, receiptLineId, postedReceipt.inventoryMovementId]
  );
  assert.equal(Number(costLayerResult.rows[0]?.count ?? 0), 1);
});

test('return receipt posting replays cleanly and does not duplicate inventory movements', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-return-replay',
    tenantName: 'Return Receipt Replay Tenant'
  });
  const { topology } = harness;
  const customer = await harness.createCustomer('RET-REPLAY');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.HOLD.id,
    skuPrefix: 'RET-REPLAY',
    type: 'raw'
  });

  const authorization = await createReturnAuthorization(harness.tenantId, {
    rmaNumber: `RMA-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'authorized',
    authorizedAt: '2026-03-07T00:00:00.000Z',
    lines: [{
      itemId: item.id,
      uom: 'each',
      quantityAuthorized: 1
    }]
  });

  const receipt = await createReturnReceipt(harness.tenantId, {
    returnAuthorizationId: authorization.id,
    receivedAt: '2026-03-08T00:00:00.000Z',
    receivedToLocationId: topology.defaults.HOLD.id,
    lines: [{
      returnAuthorizationLineId: authorization.lines[0].id,
      itemId: item.id,
      uom: 'each',
      quantityReceived: 1
    }]
  });

  const idempotencyKey = `return-receipt-post:${randomUUID()}`;
  const firstPost = await postReturnReceipt(harness.tenantId, receipt.id, { idempotencyKey });
  const replayPost = await postReturnReceipt(harness.tenantId, receipt.id, { idempotencyKey });

  assert.equal(replayPost.id, firstPost.id);
  assert.equal(replayPost.inventoryMovementId, firstPost.inventoryMovementId);

  const movementCount = await harness.pool.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = 'return_receipt_post'
        AND source_id = $2`,
    [harness.tenantId, receipt.id]
  );
  assert.equal(Number(movementCount.rows[0]?.count ?? 0), 1);
});

test('return receipt retry repairs a recoverable partial document state without duplicating movements', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-return-receipt-partial',
    tenantName: 'Return Receipt Partial Tenant'
  });
  const { receipt } = await createPostedReturnReceiptFixture(harness, {
    customerPrefix: 'RET-PARTIAL',
    skuPrefix: 'RET-PARTIAL'
  });

  await harness.pool.query(
    `UPDATE return_receipts
        SET status = 'draft',
            inventory_movement_id = NULL
      WHERE tenant_id = $1
        AND id = $2`,
    [harness.tenantId, receipt.id]
  );

  const repaired = await postReturnReceipt(harness.tenantId, receipt.id, {
    idempotencyKey: `return-receipt-post:${randomUUID()}`
  });
  assert.equal(repaired.status, 'posted');
  assert.equal(repaired.inventoryMovementId, receipt.inventoryMovementId);

  const movementCount = await harness.pool.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = 'return_receipt_post'
        AND source_id = $2`,
    [harness.tenantId, receipt.id]
  );
  assert.equal(Number(movementCount.rows[0]?.count ?? 0), 1);
});

test('return receipt retry tolerates linkage drift by repairing the document pointer to the authoritative movement', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-return-receipt-drift',
    tenantName: 'Return Receipt Drift Tenant'
  });
  const primary = await createPostedReturnReceiptFixture(harness, {
    customerPrefix: 'RET-DRIFT-A',
    skuPrefix: 'RET-DRIFT-A'
  });
  const syntheticMovementId = randomUUID();
  const syntheticHash = buildMovementDeterministicHash({
    tenantId: harness.tenantId,
    movementType: 'receive',
    occurredAt: '2026-03-08T00:00:00.000Z',
    sourceType: 'manual_test_drift',
    sourceId: `drift:${primary.receipt.id}`,
    lines: [{
      itemId: primary.item.id,
      locationId: primary.topology.defaults.HOLD.id,
      quantityDelta: 1,
      canonicalUom: 'each',
      unitCost: 0,
      reasonCode: 'manual_test_drift'
    }]
  });

  await harness.pool.query(
    `INSERT INTO inventory_movements (
        id,
        movement_type,
        status,
        external_ref,
        occurred_at,
        posted_at,
        notes,
        created_at,
        updated_at,
        tenant_id,
        metadata,
        idempotency_key,
        source_type,
        source_id,
        movement_deterministic_hash
      ) VALUES ($1,'receive','posted',$2,$3,$3,$4,$3,$3,$5,NULL,NULL,'manual_test_drift',$6,$7)`,
    [
      syntheticMovementId,
      `drift:${syntheticMovementId}`,
      '2026-03-08T00:00:00.000Z',
      'Synthetic drift movement',
      harness.tenantId,
      `drift:${primary.receipt.id}`,
      syntheticHash
    ]
  );
  await harness.pool.query(
    `INSERT INTO inventory_movement_lines (
        id,
        movement_id,
        item_id,
        location_id,
        quantity_delta,
        uom,
        reason_code,
        line_notes,
        created_at,
        tenant_id,
        unit_cost,
        extended_cost,
        quantity_delta_entered,
        uom_entered,
        quantity_delta_canonical,
        canonical_uom,
        uom_dimension
      ) VALUES (
        $1,$2,$3,$4,$5,$6,'manual_test_drift',$7,$8,$9,$10,$11,$5,$6,$5,$12,'count'
      )`,
    [
      randomUUID(),
      syntheticMovementId,
      primary.item.id,
      primary.topology.defaults.HOLD.id,
      1,
      'each',
      'Synthetic drift movement line',
      '2026-03-08T00:00:00.000Z',
      harness.tenantId,
      0,
      0,
      'each'
    ]
  );
  await harness.pool.query(
    `UPDATE return_receipts
        SET inventory_movement_id = $3
      WHERE tenant_id = $1
        AND id = $2`,
    [harness.tenantId, primary.receipt.id, syntheticMovementId]
  );

  const repaired = await postReturnReceipt(harness.tenantId, primary.receipt.id, {
    idempotencyKey: `return-receipt-post:${randomUUID()}`
  });
  assert.equal(repaired.inventoryMovementId, primary.receipt.inventoryMovementId);

  const persisted = await getReturnReceipt(harness.tenantId, primary.receipt.id);
  assert.equal(persisted?.inventoryMovementId, primary.receipt.inventoryMovementId);
});

test('return receipt retry fails closed when authoritative movement state is irrecoverably corrupted', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-return-receipt-irrec',
    tenantName: 'Return Receipt Irrecoverable Tenant'
  });
  const { receipt } = await createPostedReturnReceiptFixture(harness, {
    customerPrefix: 'RET-IRREC',
    skuPrefix: 'RET-IRREC'
  });

  const ambiguousMovementId = randomUUID();
  const ambiguousHash = buildMovementDeterministicHash({
    tenantId: harness.tenantId,
    movementType: 'transfer',
    occurredAt: '2026-03-09T00:00:00.000Z',
    sourceType: 'return_receipt_post',
    sourceId: receipt.id,
    lines: []
  });

  await harness.pool.query(
    `INSERT INTO inventory_movements (
        id,
        movement_type,
        status,
        external_ref,
        occurred_at,
        posted_at,
        notes,
        created_at,
        updated_at,
        tenant_id,
        metadata,
        idempotency_key,
        source_type,
        source_id,
        movement_deterministic_hash
      ) VALUES ($1,'transfer','posted',$2,$3,$3,$4,$3,$3,$5,NULL,NULL,'return_receipt_post',$6,$7)`,
    [
      ambiguousMovementId,
      `corrupt:${ambiguousMovementId}`,
      '2026-03-09T00:00:00.000Z',
      'Ambiguous authoritative receipt movement',
      harness.tenantId,
      receipt.id,
      ambiguousHash
    ]
  );

  await assert.rejects(
    () =>
      postReturnReceipt(harness.tenantId, receipt.id, {
        idempotencyKey: `return-receipt-post:${randomUUID()}`
      }),
    (error) =>
      error?.code === 'RETURN_RECEIPT_RECOVERY_IRRECOVERABLE'
      || error?.message === 'RETURN_RECEIPT_RECOVERY_IRRECOVERABLE'
  );
});

test('return receipt posting prevents duplicate movements even when retried with a new idempotency key', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-return-receipt-duplicate',
    tenantName: 'Return Receipt Duplicate Tenant'
  });
  const { receipt } = await createPostedReturnReceiptFixture(harness, {
    customerPrefix: 'RET-DUP',
    skuPrefix: 'RET-DUP'
  });

  const secondPost = await postReturnReceipt(harness.tenantId, receipt.id, {
    idempotencyKey: `return-receipt-post:${randomUUID()}`
  });
  assert.equal(secondPost.inventoryMovementId, receipt.inventoryMovementId);

  const movementCount = await harness.pool.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = 'return_receipt_post'
        AND source_id = $2`,
    [harness.tenantId, receipt.id]
  );
  assert.equal(Number(movementCount.rows[0]?.count ?? 0), 1);
});

test('return receipt posting preserves tenant scope', async () => {
  const sourceHarness = await createServiceHarness({
    tenantPrefix: 'contract-return-tenant-a',
    tenantName: 'Return Receipt Tenant A'
  });
  const targetHarness = await createServiceHarness({
    tenantPrefix: 'contract-return-tenant-b',
    tenantName: 'Return Receipt Tenant B'
  });
  const { topology } = sourceHarness;
  const customer = await sourceHarness.createCustomer('RET-TENANT');
  const item = await sourceHarness.createItem({
    defaultLocationId: topology.defaults.HOLD.id,
    skuPrefix: 'RET-TENANT',
    type: 'raw'
  });

  const authorization = await createReturnAuthorization(sourceHarness.tenantId, {
    rmaNumber: `RMA-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'authorized',
    authorizedAt: '2026-03-09T00:00:00.000Z',
    lines: [{
      itemId: item.id,
      uom: 'each',
      quantityAuthorized: 1
    }]
  });

  const receipt = await createReturnReceipt(sourceHarness.tenantId, {
    returnAuthorizationId: authorization.id,
    receivedAt: '2026-03-10T00:00:00.000Z',
    receivedToLocationId: topology.defaults.HOLD.id,
    lines: [{
      returnAuthorizationLineId: authorization.lines[0].id,
      itemId: item.id,
      uom: 'each',
      quantityReceived: 1
    }]
  });

  await assert.rejects(
    () =>
      postReturnReceipt(targetHarness.tenantId, receipt.id, {
        idempotencyKey: `return-receipt-post:${randomUUID()}`
      }),
    (error) => error?.message === 'RETURN_RECEIPT_NOT_FOUND'
  );

  const stillDraft = await getReturnReceipt(sourceHarness.tenantId, receipt.id);
  assert.equal(stillDraft?.status, 'draft');
  assert.equal(stillDraft?.inventoryMovementId, null);
});
