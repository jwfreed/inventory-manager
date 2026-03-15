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

test('return receipt creation remains draft-only and posting creates the authoritative receive movement', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-return-receipt',
    tenantName: 'Return Receipt Contract Tenant'
  });
  const { topology } = harness;
  const customer = await harness.createCustomer('RET');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
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
    receivedAt: '2026-03-06T00:00:00.000Z',
    receivedToLocationId: topology.defaults.SELLABLE.id,
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
      locationId: topology.defaults.SELLABLE.id,
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
    defaultLocationId: topology.defaults.SELLABLE.id,
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
    receivedToLocationId: topology.defaults.SELLABLE.id,
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
    defaultLocationId: topology.defaults.SELLABLE.id,
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
    receivedToLocationId: topology.defaults.SELLABLE.id,
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
