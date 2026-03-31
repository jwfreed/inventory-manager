import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  buildReceiptCloseoutBlockers,
  assertReceiptCloseoutAllowed
} = require('../../src/domain/receipts/receiptCloseoutPolicy.ts');

test('closeout blockers include unresolved discrepancies and operational blockers', () => {
  const reasons = buildReceiptCloseoutBlockers({
    openDiscrepancyCount: 1,
    lineFacts: [
      {
        remainingToPutaway: 2,
        holdQty: 1,
        allocationQuantityMatchesReceipt: false
      }
    ]
  });
  assert.deepEqual(reasons, [
    'Receipt reconciliation required before closeout.',
    'Receipt allocation total does not match received quantity.',
    'QC hold unresolved.',
    'Accepted quantity remains outside available bins.'
  ]);
});

test('closeout policy throws when any blocker remains', () => {
  assert.throws(
    () =>
      assertReceiptCloseoutAllowed({
        openDiscrepancyCount: 0,
        lineFacts: [
          {
            remainingToPutaway: 1,
            holdQty: 0,
            allocationQuantityMatchesReceipt: true
          }
        ]
      }),
    /RECEIPT_NOT_ELIGIBLE/
  );
});
