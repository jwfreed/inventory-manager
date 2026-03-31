import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  RECEIPT_STATES,
  buildReceiptCreationState,
  deriveReceiptState,
  transitionReceiptState
} = require('../../src/domain/receipts/receiptStateModel.ts');

test('receipt creation state always stops at QC pending', () => {
  assert.equal(buildReceiptCreationState(), RECEIPT_STATES.QC_PENDING);
});

test('receipt state cannot jump directly from received to available', () => {
  assert.throws(
    () => transitionReceiptState(RECEIPT_STATES.RECEIVED, RECEIPT_STATES.AVAILABLE),
    (error) => String(error?.message ?? '') === 'RECEIPT_INVALID_STATE_TRANSITION'
  );
});

test('receipt state remains unavailable until QC is complete', () => {
  assert.equal(
    deriveReceiptState({
      baseStatus: 'posted',
      totals: {
        totalReceived: 10,
        totalAccept: 0,
        totalHold: 0,
        totalReject: 0
      }
    }),
    RECEIPT_STATES.QC_PENDING
  );
});

test('receipt state becomes rejected on QC hold or zero accepted quantity after inspection', () => {
  assert.equal(
    deriveReceiptState({
      baseStatus: 'posted',
      totals: {
        totalReceived: 10,
        totalAccept: 0,
        totalHold: 10,
        totalReject: 0
      }
    }),
    RECEIPT_STATES.REJECTED
  );
  assert.equal(
    deriveReceiptState({
      baseStatus: 'posted',
      totals: {
        totalReceived: 10,
        totalAccept: 0,
        totalHold: 0,
        totalReject: 10
      }
    }),
    RECEIPT_STATES.REJECTED
  );
});

test('receipt state becomes available only after QC acceptance', () => {
  assert.equal(
    deriveReceiptState({
      baseStatus: 'posted',
      totals: {
        totalReceived: 10,
        totalAccept: 10,
        totalHold: 0,
        totalReject: 0
      }
    }),
    RECEIPT_STATES.AVAILABLE
  );
});
