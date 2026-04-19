import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  computeSourceLineId,
  computeSplitSourceLineIds,
  sortDeterministicMovementLines
} = require('../../src/modules/platform/application/inventoryMovementDeterminism.ts');
const {
  classifyInventoryMovementLineAction,
  assertAllocationWithinAvailable,
  assertInventoryStateTransition,
  deriveInventoryBalanceStateTransition,
  assertSourceLineQuantityConservation
} = require('../../src/modules/platform/application/inventoryMovementLineSemantics.ts');
const {
  planFifoUnitConsumption,
  rebuildInventoryUnitStates
} = require('../../src/modules/platform/application/inventoryUnitAuthority.ts');
const {
  getInventoryConsumptionPolicy,
  getInventoryReconciliationPolicy
} = require('../../src/config/inventoryPolicy.ts');

test('movement line identity is complete, deterministic, and stable for partial flows', () => {
  assert.equal(computeSourceLineId(['receipt', 'line-1']), 'receipt:line-1');
  assert.throws(() => computeSourceLineId(['receipt', '']), /INVENTORY_SOURCE_LINE_ID_INVALID/);

  const firstOrder = [{ key: 'sellable' }, { key: 'qa' }];
  const secondOrder = [...firstOrder].reverse();
  const firstIds = computeSplitSourceLineIds('receipt-line-1', firstOrder, (entry) => entry.key);
  const secondIds = computeSplitSourceLineIds('receipt-line-1', secondOrder, (entry) => entry.key);

  assert.equal(firstIds.get(firstOrder[1]), 'receipt-line-1#0');
  assert.equal(firstIds.get(firstOrder[0]), 'receipt-line-1#1');
  assert.equal(secondIds.get(firstOrder[1]), 'receipt-line-1#0');
  assert.equal(secondIds.get(firstOrder[0]), 'receipt-line-1#1');
});

test('deterministic movement sorting is independent of input ordering', () => {
  const lines = [
    { sourceLineId: 'b', warehouseId: 'w', locationId: 'l2', itemId: 'i', canonicalUom: 'each' },
    { sourceLineId: 'a', warehouseId: 'w', locationId: 'l1', itemId: 'i', canonicalUom: 'each' }
  ];
  const identity = (line) => ({
    tenantId: 't',
    warehouseId: line.warehouseId,
    locationId: line.locationId,
    itemId: line.itemId,
    canonicalUom: line.canonicalUom,
    sourceLineId: line.sourceLineId
  });

  assert.deepEqual(
    sortDeterministicMovementLines(lines, identity).map((line) => line.sourceLineId),
    sortDeterministicMovementLines([...lines].reverse(), identity).map((line) => line.sourceLineId)
  );
});

test('movement line action, conservation, allocation, and FIFO policies are explicit', () => {
  assert.equal(classifyInventoryMovementLineAction({ movementType: 'receive', quantityDelta: 1 }), 'INCREASE_ON_HAND');
  assert.equal(classifyInventoryMovementLineAction({ movementType: 'issue', quantityDelta: -1 }), 'DECREASE_ON_HAND');
  assert.equal(classifyInventoryMovementLineAction({ movementType: 'transfer', quantityDelta: -1 }), 'MOVE_LOCATION');
  assert.equal(classifyInventoryMovementLineAction({ movementType: 'allocate', quantityDelta: 1 }), 'ALLOCATE');
  assert.equal(classifyInventoryMovementLineAction({ movementType: 'release', quantityDelta: -1 }), 'RELEASE');
  assert.equal(assertInventoryStateTransition('available', 'allocated'), 'available->allocated');
  assert.equal(
    deriveInventoryBalanceStateTransition({ deltaReserved: -2, deltaAllocated: 2 }),
    'allocated->picked'
  );
  assert.equal(
    deriveInventoryBalanceStateTransition({ deltaOnHand: -2, deltaAllocated: -2 }),
    'picked->shipped'
  );
  assert.equal(
    deriveInventoryBalanceStateTransition({ deltaOnHand: -1, reasonCode: 'cycle_count_adjustment' }),
    'available->adjusted'
  );
  assert.throws(
    () => assertInventoryStateTransition('received', 'shipped'),
    /INVENTORY_STATE_TRANSITION_INVALID/
  );
  assert.doesNotThrow(() =>
    assertSourceLineQuantityConservation({
      sourceLineId: 'receipt-line-1',
      increases: [10],
      decreases: [4, 1],
      netQuantity: 5
    })
  );
  assert.throws(
    () => assertSourceLineQuantityConservation({
      sourceLineId: 'receipt-line-1',
      increases: [10],
      decreases: [4],
      netQuantity: 5
    }),
    /INVENTORY_SOURCE_LINE_CONSERVATION_VIOLATION/
  );
  assert.doesNotThrow(() => assertAllocationWithinAvailable({ allocationQuantity: 3, availableQuantity: 3 }));
  assert.throws(
    () => assertAllocationWithinAvailable({ allocationQuantity: 4, availableQuantity: 3 }),
    /INVENTORY_ALLOCATION_EXCEEDS_AVAILABLE/
  );
  assert.equal(getInventoryConsumptionPolicy(), 'FIFO');
  assert.equal(getInventoryReconciliationPolicy().autoAdjustMaxAbsQuantity, 100);
});

test('unit authority rebuilds state and plans deterministic FIFO partial consumption', () => {
  const events = [
    {
      id: '00000000-0000-0000-0000-000000000003',
      movementId: 'movement-new',
      sourceLineId: 'line-new',
      skuId: 'sku-1',
      lotId: 'lot-new',
      locationId: 'loc-a',
      unitOfMeasure: 'each',
      eventTimestamp: '2026-03-03T00:00:00.000Z',
      reasonCode: 'receipt',
      stateTransition: 'received->available',
      recordQuantityDelta: 6
    },
    {
      id: '00000000-0000-0000-0000-000000000001',
      movementId: 'movement-old',
      sourceLineId: 'line-old',
      skuId: 'sku-1',
      lotId: 'lot-old',
      locationId: 'loc-a',
      unitOfMeasure: 'each',
      eventTimestamp: '2026-03-01T00:00:00.000Z',
      reasonCode: 'receipt',
      stateTransition: 'received->available',
      recordQuantityDelta: 4
    },
    {
      id: '00000000-0000-0000-0000-000000000002',
      movementId: 'movement-other-location',
      sourceLineId: 'line-other-location',
      skuId: 'sku-1',
      lotId: 'lot-other-location',
      locationId: 'loc-b',
      unitOfMeasure: 'each',
      eventTimestamp: '2026-03-02T00:00:00.000Z',
      reasonCode: 'receipt',
      stateTransition: 'received->available',
      recordQuantityDelta: 9
    }
  ];

  assert.deepEqual(
    planFifoUnitConsumption({
      events,
      skuId: 'sku-1',
      locationId: 'loc-a',
      unitOfMeasure: 'each',
      quantity: 7
    }).map((entry) => [entry.lotId, entry.quantity]),
    [
      ['lot-old', 4],
      ['lot-new', 3]
    ]
  );
  assert.equal(rebuildInventoryUnitStates(events).length, 3);
});

test('unit authority rejects implicit mutation fields and invalid transitions', () => {
  const base = {
    id: 'event-1',
    movementId: 'movement-1',
    sourceLineId: 'line-1',
    skuId: 'sku-1',
    lotId: 'lot-1',
    locationId: 'loc-a',
    unitOfMeasure: 'each',
    eventTimestamp: '2026-03-01T00:00:00.000Z',
    reasonCode: 'receipt',
    stateTransition: 'received->available',
    recordQuantityDelta: 1
  };

  assert.throws(
    () => rebuildInventoryUnitStates([{ ...base, reasonCode: '' }]),
    /INVENTORY_UNIT_EVENT_REASON_CODE_REQUIRED/
  );
  assert.throws(
    () => rebuildInventoryUnitStates([{ ...base, stateTransition: 'received->shipped' }]),
    /INVENTORY_STATE_TRANSITION_INVALID/
  );
});

test('schema, writer, and rebuild matching enforce structural identity and event time', async () => {
  const root = process.cwd();
  const migration = await readFile(
    path.join(root, 'src/migrations/1775600000000_inventory_movement_line_identity_time.ts'),
    'utf8'
  );
  const writer = await readFile(path.join(root, 'src/domains/inventory/internal/ledgerWriter.ts'), 'utf8');
  const rebuilder = await readFile(path.join(root, 'src/domain/receipts/receiptAllocationRebuilder.ts'), 'utf8');
  const projector = await readFile(
    path.join(root, 'src/modules/availability/infrastructure/inventoryBalance.projector.ts'),
    'utf8'
  );
  const counts = await readFile(path.join(root, 'src/services/counts.service.ts'), 'utf8');
  const adjustments = await readFile(path.join(root, 'src/services/adjustments/posting.service.ts'), 'utf8');

  assert.match(migration, /source_line_id/);
  assert.match(migration, /event_timestamp/);
  assert.match(migration, /recorded_at/);
  assert.match(migration, /movement_id.*source_line_id/s);
  assert.match(migration, /where: 'source_line_id IS NOT NULL'/);

  assert.match(writer, /INVENTORY_MOVEMENT_LINE_SOURCE_LINE_ID_REQUIRED/);
  assert.match(writer, /INVENTORY_MOVEMENT_LINE_EVENT_TIMESTAMP_REQUIRED/);
  assert.match(writer, /source_line_id, event_timestamp, recorded_at/);

  assert.match(rebuilder, /AND source_line_id = \$3/);
  assert.match(rebuilder, /RECEIPT_ALLOCATION_REBUILD_LEGACY_MOVEMENT_LINE_FALLBACK/);
  assert.match(rebuilder, /ORDER BY COALESCE\(event_timestamp, created_at\) ASC, id ASC/);

  assert.match(projector, /recordAuditLog/);
  assert.match(projector, /state_transition/);
  assert.match(projector, /record_quantity: current/);
  assert.match(projector, /physical_quantity: null/);
  assert.match(projector, /physical_quantity_source: 'not_observed'/);
  assert.doesNotMatch(projector, /console\.(log|warn|error)/);

  assert.match(counts, /COUNT_RECONCILIATION_ESCALATION_REQUIRED/);
  assert.match(counts, /getInventoryReconciliationPolicy/);
  assert.match(adjustments, /ADJUSTMENT_REASON_REQUIRED/);
});
