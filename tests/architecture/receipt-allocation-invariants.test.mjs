import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  RECEIPT_ALLOCATION_STATUSES,
  ReceiptAllocationAggregate,
  assertReceiptAllocationMappingConsistency,
  assertReceiptAllocationTraceability,
  assertReceiptAllocationQuantityConservation,
  deriveReceiptAvailabilityFromAllocations,
  buildReceiptPostingIntegrity,
  reconcileReceiptPhysicalCount,
  moveReceiptAllocations
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

test('allocation mappings cannot assign one movement line to conflicting targets', () => {
  assert.throws(
    () =>
      assertReceiptAllocationMappingConsistency([
        {
          receiptId: 'r1',
          receiptLineId: 'l1',
          warehouseId: 'w1',
          locationId: 'qa',
          binId: 'qa-bin',
          inventoryMovementId: 'm1',
          inventoryMovementLineId: 'ml1',
          costLayerId: 'cl1',
          quantity: 2,
          status: RECEIPT_ALLOCATION_STATUSES.QA
        },
        {
          receiptId: 'r1',
          receiptLineId: 'l1',
          warehouseId: 'w1',
          locationId: 'sellable',
          binId: 'sellable-bin',
          inventoryMovementId: 'm1',
          inventoryMovementLineId: 'ml1',
          costLayerId: 'cl1',
          quantity: 2,
          status: RECEIPT_ALLOCATION_STATUSES.AVAILABLE
        }
      ]),
    /RECEIPT_ALLOCATION_CONFLICTING_MAPPING/
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

test('receipt allocation aggregate owns repeated consumption state', () => {
  const aggregate = ReceiptAllocationAggregate.create({
    expectedQtyByReceiptLineId: new Map([['l1', 5]]),
    allocations: [
      {
        id: 'a1',
        receiptId: 'r1',
        receiptLineId: 'l1',
        warehouseId: 'w1',
        locationId: 'qa',
        binId: 'qa-bin',
        inventoryMovementId: 'm1',
        inventoryMovementLineId: 'ml1',
        costLayerId: 'cl1',
        quantity: 5,
        status: RECEIPT_ALLOCATION_STATUSES.QA
      }
    ]
  });

  aggregate.assertRequirements([
    {
      receiptLineId: 'l1',
      requiredStatus: RECEIPT_ALLOCATION_STATUSES.QA,
      requiredBinId: 'qa-bin',
      requiredQuantity: 2
    },
    {
      receiptLineId: 'l1',
      requiredStatus: RECEIPT_ALLOCATION_STATUSES.QA,
      requiredBinId: 'qa-bin',
      requiredQuantity: 3
    }
  ]);

  aggregate.applyConsume({
    receiptLineId: 'l1',
    quantity: 3,
    sourceStatus: RECEIPT_ALLOCATION_STATUSES.QA,
    sourceBinId: 'qa-bin',
    destinationLocationId: 'sellable',
    destinationBinId: 'sellable-bin',
    destinationStatus: RECEIPT_ALLOCATION_STATUSES.AVAILABLE,
    movementId: 'm2',
    movementLineId: 'ml2'
  });

  assert.throws(
    () =>
      aggregate.assertRequirements([
        {
          receiptLineId: 'l1',
          requiredStatus: RECEIPT_ALLOCATION_STATUSES.QA,
          requiredBinId: 'qa-bin',
          requiredQuantity: 3
        }
      ]),
    /RECEIPT_ALLOCATION_PRECHECK_FAILED/
  );
});

test('receipt allocation aggregate rejects unsafe status transitions and missing bin targets', () => {
  const aggregate = ReceiptAllocationAggregate.create({
    expectedQtyByReceiptLineId: new Map([['l1', 2]]),
    allocations: [
      {
        id: 'a1',
        receiptId: 'r1',
        receiptLineId: 'l1',
        warehouseId: 'w1',
        locationId: 'sellable',
        binId: 'sellable-bin',
        inventoryMovementId: 'm1',
        inventoryMovementLineId: 'ml1',
        costLayerId: 'cl1',
        quantity: 2,
        status: RECEIPT_ALLOCATION_STATUSES.AVAILABLE
      }
    ]
  });

  assert.throws(
    () =>
      aggregate.applyConsume({
        receiptLineId: 'l1',
        quantity: 1,
        sourceStatus: RECEIPT_ALLOCATION_STATUSES.AVAILABLE,
        sourceBinId: 'sellable-bin',
        destinationLocationId: 'hold',
        destinationBinId: 'hold-bin',
        destinationStatus: RECEIPT_ALLOCATION_STATUSES.HOLD,
        movementId: 'm2',
        movementLineId: 'ml2'
      }),
    /RECEIPT_ALLOCATION_STATUS_TRANSITION_INVALID/
  );

  assert.throws(
    () =>
      aggregate.applyConsume({
        receiptLineId: 'l1',
        quantity: 1,
        sourceStatus: RECEIPT_ALLOCATION_STATUSES.AVAILABLE,
        sourceBinId: '',
        movementId: 'm2',
        movementLineId: 'ml2',
        expectedQuantityDelta: -1
      }),
    /RECEIPT_ALLOCATION_BIN_TARGET_REQUIRED/
  );
});

test('receipt allocation mutation rejects fabricated validation context', async () => {
  await assert.rejects(
    moveReceiptAllocations({
      client: { query: async () => ({ rowCount: 0, rows: [] }) },
      tenantId: 't1',
      context: {
        tenantId: 't1',
        kind: 'validated',
        receiptLineIds: new Set(['l1']),
        allocationsByLine: new Map()
      },
      receiptLineId: 'l1',
      quantity: 1,
      sourceStatus: RECEIPT_ALLOCATION_STATUSES.QA,
      sourceBinId: 'qa-bin',
      movementId: 'm1',
      movementLineId: 'ml1',
      occurredAt: new Date(),
      expectedQuantityDelta: -1
    }),
    /RECEIPT_ALLOCATION_VALIDATION_REQUIRED/
  );
});

test('rework and discarded allocations are counted in blocked quantity', () => {
  // availableQty + blockedQty must equal totalQty when terminal dispositions exist
  const availability = deriveReceiptAvailabilityFromAllocations({
    baseStatus: 'posted',
    lifecycleState: RECEIPT_STATES.AVAILABLE,
    allocations: [
      {
        receiptId: 'r1',
        receiptLineId: 'l1',
        warehouseId: 'w1',
        locationId: 'sellable',
        binId: 'sellable-bin',
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
        locationId: 'reject',
        binId: 'reject-bin',
        inventoryMovementId: 'm2',
        inventoryMovementLineId: 'ml2',
        costLayerId: 'cl1',
        quantity: 3,
        status: RECEIPT_ALLOCATION_STATUSES.REWORK
      },
      {
        receiptId: 'r1',
        receiptLineId: 'l1',
        warehouseId: 'w1',
        locationId: 'reject',
        binId: 'reject-bin',
        inventoryMovementId: 'm3',
        inventoryMovementLineId: 'ml3',
        costLayerId: 'cl1',
        quantity: 2,
        status: RECEIPT_ALLOCATION_STATUSES.DISCARDED
      }
    ]
  });
  assert.equal(availability.availableQty, 5);
  assert.equal(availability.blockedQty, 5, 'rework(3) + discarded(2) must appear in blockedQty');
  assert.equal(
    availability.availableQty + availability.blockedQty,
    10,
    'availableQty + blockedQty must equal totalQty'
  );
});

test('conservation holds after hold transitions to rework and discarded', () => {
  const aggregate = ReceiptAllocationAggregate.create({
    expectedQtyByReceiptLineId: new Map([['l1', 10]]),
    allocations: [
      {
        id: 'a1',
        receiptId: 'r1',
        receiptLineId: 'l1',
        warehouseId: 'w1',
        locationId: 'hold',
        binId: 'hold-bin',
        inventoryMovementId: 'm1',
        inventoryMovementLineId: 'ml1',
        costLayerId: 'cl1',
        quantity: 10,
        status: RECEIPT_ALLOCATION_STATUSES.HOLD
      }
    ]
  });

  aggregate.applyConsume({
    receiptLineId: 'l1',
    quantity: 6,
    sourceStatus: RECEIPT_ALLOCATION_STATUSES.HOLD,
    sourceBinId: 'hold-bin',
    destinationLocationId: 'reject',
    destinationBinId: 'reject-bin',
    destinationStatus: RECEIPT_ALLOCATION_STATUSES.REWORK,
    movementId: 'm2',
    movementLineId: 'ml2'
  });

  aggregate.applyConsume({
    receiptLineId: 'l1',
    quantity: 4,
    sourceStatus: RECEIPT_ALLOCATION_STATUSES.HOLD,
    sourceBinId: 'hold-bin',
    destinationLocationId: 'reject',
    destinationBinId: 'reject-bin',
    destinationStatus: RECEIPT_ALLOCATION_STATUSES.DISCARDED,
    movementId: 'm3',
    movementLineId: 'ml3'
  });

  const allocations = aggregate.snapshotAllocations();
  const total = allocations.reduce((sum, a) => sum + a.quantity, 0);
  assert.equal(Math.round(total * 1e6) / 1e6, 10, 'total quantity must be conserved');
  assert.equal(allocations.filter((a) => a.status === RECEIPT_ALLOCATION_STATUSES.HOLD).length, 0);
  assert.equal(allocations.filter((a) => a.status === RECEIPT_ALLOCATION_STATUSES.REWORK).length, 1);
  assert.equal(allocations.filter((a) => a.status === RECEIPT_ALLOCATION_STATUSES.DISCARDED).length, 1);
});

test('receipt allocation aggregate rejects transitions from terminal states', () => {
  const aggregate = ReceiptAllocationAggregate.create({
    expectedQtyByReceiptLineId: new Map([['l1', 4]]),
    allocations: [
      {
        id: 'a1',
        receiptId: 'r1',
        receiptLineId: 'l1',
        warehouseId: 'w1',
        locationId: 'reject',
        binId: 'reject-bin',
        inventoryMovementId: 'm1',
        inventoryMovementLineId: 'ml1',
        costLayerId: 'cl1',
        quantity: 2,
        status: RECEIPT_ALLOCATION_STATUSES.REWORK
      },
      {
        id: 'a2',
        receiptId: 'r1',
        receiptLineId: 'l1',
        warehouseId: 'w1',
        locationId: 'reject',
        binId: 'reject-bin',
        inventoryMovementId: 'm2',
        inventoryMovementLineId: 'ml2',
        costLayerId: 'cl1',
        quantity: 2,
        status: RECEIPT_ALLOCATION_STATUSES.DISCARDED
      }
    ]
  });

  assert.throws(
    () =>
      aggregate.applyConsume({
        receiptLineId: 'l1',
        quantity: 1,
        sourceStatus: RECEIPT_ALLOCATION_STATUSES.REWORK,
        sourceBinId: 'reject-bin',
        destinationLocationId: 'sellable',
        destinationBinId: 'sellable-bin',
        destinationStatus: RECEIPT_ALLOCATION_STATUSES.AVAILABLE,
        movementId: 'm3',
        movementLineId: 'ml3'
      }),
    /RECEIPT_ALLOCATION_STATUS_TRANSITION_INVALID/,
    'REWORK must be a terminal state with no valid outgoing transitions'
  );

  assert.throws(
    () =>
      aggregate.applyConsume({
        receiptLineId: 'l1',
        quantity: 1,
        sourceStatus: RECEIPT_ALLOCATION_STATUSES.DISCARDED,
        sourceBinId: 'reject-bin',
        destinationLocationId: 'sellable',
        destinationBinId: 'sellable-bin',
        destinationStatus: RECEIPT_ALLOCATION_STATUSES.AVAILABLE,
        movementId: 'm4',
        movementLineId: 'ml4'
      }),
    /RECEIPT_ALLOCATION_STATUS_TRANSITION_INVALID/,
    'DISCARDED must be a terminal state with no valid outgoing transitions'
  );
});
