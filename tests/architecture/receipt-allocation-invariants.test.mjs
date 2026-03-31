import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  RECEIPT_ALLOCATION_STATUSES,
  assertReceiptAllocationTraceability,
  assertReceiptAllocationQuantityConservation,
  deriveReceiptAvailabilityFromAllocations,
  buildReceiptPostingIntegrity,
  reconcileReceiptPhysicalCount
} = require('../../src/domain/receipts/receiptAllocationModel.ts');
const { RECEIPT_STATES } = require('../../src/domain/receipts/receiptStateModel.ts');

test('allocation sums must match receipt quantity', () => {
  const allocations = [
    {
      receiptId: 'r1',
      receiptLineId: 'l1',
      warehouseId: 'w1',
      locationId: 'qa',
      binId: 'qa',
      inventoryMovementId: 'm1',
      inventoryMovementLineId: 'ml1',
      costLayerId: 'cl1',
      quantity: 6,
      status: RECEIPT_ALLOCATION_STATUSES.QA
    },
    {
      receiptId: 'r1',
      receiptLineId: 'l1',
      warehouseId: 'w1',
      locationId: 'hold',
      binId: 'hold',
      inventoryMovementId: 'm2',
      inventoryMovementLineId: 'ml2',
      costLayerId: 'cl1',
      quantity: 4,
      status: RECEIPT_ALLOCATION_STATUSES.HOLD
    }
  ];
  const summary = assertReceiptAllocationQuantityConservation({ receiptQuantity: 10, allocations });
  assert.equal(summary.totalQty, 10);
});

test('allocation traceability requires an explicit bin distinct from location context', () => {
  assert.throws(
    () =>
      assertReceiptAllocationTraceability([
        {
          receiptId: 'r1',
          receiptLineId: 'l1',
          warehouseId: 'w1',
          locationId: 'qa-location',
          binId: null,
          inventoryMovementId: 'm1',
          inventoryMovementLineId: 'ml1',
          costLayerId: 'cl1',
          quantity: 1,
          status: RECEIPT_ALLOCATION_STATUSES.QA
        }
      ]),
    /RECEIPT_ALLOCATION_TRACEABILITY_VIOLATION/
  );
});

test('availability derives only from available allocations', () => {
  const availability = deriveReceiptAvailabilityFromAllocations({
    baseStatus: 'posted',
    lifecycleState: RECEIPT_STATES.AVAILABLE,
    allocations: [
      {
        receiptId: 'r1',
        receiptLineId: 'l1',
        warehouseId: 'w1',
        locationId: 'sellable',
        binId: 'sellable',
        inventoryMovementId: 'm1',
        inventoryMovementLineId: 'ml1',
        costLayerId: 'cl1',
        quantity: 5,
        status: RECEIPT_ALLOCATION_STATUSES.AVAILABLE
      },
      {
        receiptId: 'r1',
        receiptLineId: 'l1',
        warehouseId: 'w1',
        locationId: 'qa',
        binId: 'qa',
        inventoryMovementId: 'm1',
        inventoryMovementLineId: 'ml2',
        costLayerId: 'cl1',
        quantity: 3,
        status: RECEIPT_ALLOCATION_STATUSES.QA
      },
      {
        receiptId: 'r1',
        receiptLineId: 'l1',
        warehouseId: 'w1',
        locationId: 'hold',
        binId: 'hold',
        inventoryMovementId: 'm2',
        inventoryMovementLineId: 'ml3',
        costLayerId: 'cl1',
        quantity: 2,
        status: RECEIPT_ALLOCATION_STATUSES.HOLD
      }
    ]
  });
  assert.equal(availability.availableQty, 5);
  assert.equal(availability.blockedQty, 5);
});

test('posting integrity fails when allocations do not match posted receipt quantities', () => {
  assert.throws(
    () =>
      buildReceiptPostingIntegrity({
        expectedQtyByReceiptLineId: new Map([['l1', 10]]),
        allocationsByReceiptLineId: new Map([
          [
            'l1',
            [
              {
                receiptId: 'r1',
                receiptLineId: 'l1',
                warehouseId: 'w1',
                locationId: 'qa',
                binId: 'qa',
                inventoryMovementId: 'm1',
                inventoryMovementLineId: 'ml1',
                costLayerId: 'cl1',
                quantity: 9,
                status: RECEIPT_ALLOCATION_STATUSES.QA
              }
            ]
          ]
        ]),
        postedQtyByReceiptLineId: new Map([['l1', 10]])
      }),
    /RECEIPT_ALLOCATION_QUANTITY_MISMATCH|RECEIPT_POSTING_TRACE_INTEGRITY_VIOLATION/
  );
});

test('physical reconciliation detects mismatched counts', () => {
  const result = reconcileReceiptPhysicalCount({
    expectedQty: 10,
    physicalCount: {
      receiptLineId: 'l1',
      countedQty: 7,
      toleranceQty: 1
    }
  });
  assert.equal(result.discrepancyQty, -3);
  assert.equal(result.withinTolerance, false);
});
