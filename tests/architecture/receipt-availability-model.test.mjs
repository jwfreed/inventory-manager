import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { RECEIPT_STATES } = require('../../src/domain/receipts/receiptStateModel.ts');
const {
  deriveReceiptAvailability,
  assertReceiptQcOutcomeIntegrity
} = require('../../src/domain/receipts/receiptAvailabilityModel.ts');

test('qc outcome preserves mixed accepted held rejected quantities exactly', () => {
  const outcome = assertReceiptQcOutcomeIntegrity({
    quantityReceived: 10,
    acceptedQty: 6,
    heldQty: 3,
    rejectedQty: 1
  });
  assert.equal(outcome.inspectedQty, 10);
  assert.equal(outcome.remainingQty, 0);
});

test('availability stays blocked while accepted stock remains outside available locations', () => {
  const availability = deriveReceiptAvailability({
    baseStatus: 'posted',
    lifecycleState: RECEIPT_STATES.PUTAWAY_PENDING,
    acceptedQty: 10,
    heldQty: 0,
    postedToAvailableQty: 4
  });
  assert.equal(availability.state, 'UNAVAILABLE');
  assert.equal(availability.availableQty, 0);
});

test('held quantity never leaks into available quantity', () => {
  const availability = deriveReceiptAvailability({
    baseStatus: 'posted',
    lifecycleState: RECEIPT_STATES.AVAILABLE,
    acceptedQty: 8,
    heldQty: 2,
    postedToAvailableQty: 8
  });
  assert.equal(availability.state, 'AVAILABLE');
  assert.equal(availability.availableQty, 8);
  assert.ok(availability.blockedQty >= 2);
});
