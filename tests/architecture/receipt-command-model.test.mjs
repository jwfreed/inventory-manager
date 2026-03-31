import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  RECEIPT_EVENTS,
  RECEIPT_STATES,
  transitionReceiptState
} = require('../../src/domain/receipts/receiptStateModel.ts');

test('receipt commands cannot bypass validation before inventory posting', () => {
  assert.throws(
    () => transitionReceiptState(RECEIPT_STATES.RECEIVED, RECEIPT_EVENTS.START_QC),
    /RECEIPT_INVALID_STATE_TRANSITION/
  );
});

test('receipt commands cannot bypass qc before putaway completion', () => {
  assert.throws(
    () => transitionReceiptState(RECEIPT_STATES.QC_PENDING, RECEIPT_EVENTS.COMPLETE_PUTAWAY),
    /RECEIPT_INVALID_STATE_TRANSITION/
  );
});

test('receipt putaway lifecycle remains explicit for partial and full completion', () => {
  const qcCompleted = transitionReceiptState(RECEIPT_STATES.QC_PENDING, RECEIPT_EVENTS.COMPLETE_QC);
  const putawayPending = transitionReceiptState(qcCompleted, RECEIPT_EVENTS.START_PUTAWAY);
  const available = transitionReceiptState(putawayPending, RECEIPT_EVENTS.COMPLETE_PUTAWAY);
  assert.equal(qcCompleted, RECEIPT_STATES.QC_COMPLETED);
  assert.equal(putawayPending, RECEIPT_STATES.PUTAWAY_PENDING);
  assert.equal(available, RECEIPT_STATES.AVAILABLE);
});
