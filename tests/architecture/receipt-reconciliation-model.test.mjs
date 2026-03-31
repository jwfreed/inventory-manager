import test from 'node:test';
import assert from 'node:assert/strict';

function buildDiscrepancy({ expectedQty, actualQty, toleranceQty = 0 }) {
  const discrepancyQty = Number((actualQty - expectedQty).toFixed(6));
  return {
    expectedQty,
    actualQty,
    toleranceQty,
    discrepancyQty,
    actionable: Math.abs(discrepancyQty) > toleranceQty
  };
}

test('posting integrity discrepancies are actionable when allocations drift from receipt quantity', () => {
  const discrepancy = buildDiscrepancy({ expectedQty: 10, actualQty: 8 });
  assert.equal(discrepancy.discrepancyQty, -2);
  assert.equal(discrepancy.actionable, true);
});

test('physical reconciliation remains non-actionable only within tolerance', () => {
  const discrepancy = buildDiscrepancy({ expectedQty: 10, actualQty: 9.6, toleranceQty: 0.5 });
  assert.equal(discrepancy.actionable, false);
});
