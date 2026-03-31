import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  RECEIPT_EVENTS,
  RECEIPT_STATES,
  buildReceiptCreationState,
  transitionReceiptState
} = require('../../src/domain/receipts/receiptStateModel.ts');

test('receipt creation state always stops at QC pending', () => {
  assert.equal(buildReceiptCreationState(), RECEIPT_STATES.QC_PENDING);
});

test('receipt state cannot jump directly from received to available', () => {
  assert.throws(
    () => transitionReceiptState(RECEIPT_STATES.RECEIVED, RECEIPT_EVENTS.COMPLETE_PUTAWAY),
    (error) => String(error?.message ?? '') === 'RECEIPT_INVALID_STATE_TRANSITION'
  );
});

test('receipt state machine enforces the required creation path', () => {
  assert.equal(
    transitionReceiptState(RECEIPT_STATES.RECEIVED, RECEIPT_EVENTS.VALIDATE),
    RECEIPT_STATES.VALIDATED
  );
  assert.equal(
    transitionReceiptState(RECEIPT_STATES.VALIDATED, RECEIPT_EVENTS.START_QC),
    RECEIPT_STATES.QC_PENDING
  );
});

test('receipt state requires qc completion before rejection', () => {
  assert.equal(
    transitionReceiptState(
      transitionReceiptState(RECEIPT_STATES.QC_PENDING, RECEIPT_EVENTS.COMPLETE_QC),
      RECEIPT_EVENTS.REJECT
    ),
    RECEIPT_STATES.REJECTED
  );
});

test('receipt state becomes qc completed after explicit qc completion', () => {
  assert.equal(
    transitionReceiptState(RECEIPT_STATES.QC_PENDING, RECEIPT_EVENTS.COMPLETE_QC),
    RECEIPT_STATES.QC_COMPLETED
  );
});

test('receipt state becomes putaway pending only after explicit putaway start', () => {
  assert.equal(
    transitionReceiptState(RECEIPT_STATES.QC_COMPLETED, RECEIPT_EVENTS.START_PUTAWAY),
    RECEIPT_STATES.PUTAWAY_PENDING
  );
});

test('receipt state becomes available only after explicit putaway completion', () => {
  assert.equal(
    transitionReceiptState(RECEIPT_STATES.PUTAWAY_PENDING, RECEIPT_EVENTS.COMPLETE_PUTAWAY),
    RECEIPT_STATES.AVAILABLE
  );
});
