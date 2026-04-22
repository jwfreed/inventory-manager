/**
 * WP5: Putaway allocation eligibility — unit contract for calculatePutawayAvailability.
 *
 * Invariants under test:
 *   1. Only AVAILABLE (QC-accepted) quantity flows to putaway.
 *   2. HOLD quantity is excluded regardless of accept quantity.
 *   3. REWORK and DISCARDED quantities (derived from HOLD via hold_disposition_events)
 *      are excluded — they reduce net_hold, which does NOT inflate qcAllowed.
 *   4. When accept > 0 and hold > 0 (partial receipt), exactly accept qty is eligible.
 *   5. When accept = 0 and hold > 0, putaway is blocked.
 *   6. Uninspected quantity always blocks putaway.
 *   7. Conservation: qcAllowed never exceeds receiptQty or accept.
 *   8. Already-posted qty reduces availableForPlanning without affecting qcAllowed.
 */

import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { calculatePutawayAvailability } = require('../../src/services/inbound/receivingAggregations.ts');

function makeContext(quantityReceived) {
  return {
    id: 'line-1',
    receiptId: 'receipt-1',
    purchaseOrderId: 'po-1',
    itemId: 'item-1',
    uom: 'each',
    quantityReceived,
    defaultFromLocationId: 'qa-location-1'
  };
}

function makeQc({ accept = 0, hold = 0, reject = 0, disposed = 0 } = {}) {
  return { accept, hold, reject, disposed };
}

function makeTotals({ posted = 0, pending = 0, qa = 0, hold = 0 } = {}) {
  return { posted, pending, qa, hold };
}

// ─── 1. AVAILABLE only: full receipt accepted, no hold ────────────────────────

test('full accept, no hold: all qty eligible for putaway', () => {
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 100, hold: 0 }),
    makeTotals()
  );
  assert.equal(result.blockedReason, undefined);
  assert.equal(result.availableForPlanning, 100);
  assert.equal(result.remainingAfterPosted, 100);
});

// ─── 2. Partial receipt: accept=60, hold=40 ──────────────────────────────────

test('partial receipt accept=60 hold=40: only accepted qty flows to putaway', () => {
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 60, hold: 40 }),
    makeTotals()
  );
  // HOLD must NOT block the accepted qty
  assert.equal(result.blockedReason, undefined, 'hold should not block accepted qty');
  assert.equal(result.availableForPlanning, 60);
  assert.equal(result.remainingAfterPosted, 60);
});

test('partial receipt: putaway is blocked for qty beyond accepted amount', () => {
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 60, hold: 40 }),
    makeTotals()
  );
  // Only 60 may be planned; requesting more than 60 would exceed availableForPlanning
  assert.ok(result.availableForPlanning <= 60, 'cannot plan beyond accepted qty');
  assert.ok(result.availableForPlanning >= 60 - 1e-6, 'full accepted qty must be available');
});

// ─── 3. HOLD blocking — no accepted quantity ─────────────────────────────────

test('pure hold, no accept: putaway is blocked entirely', () => {
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 0, hold: 100 }),
    makeTotals()
  );
  assert.ok(result.blockedReason, 'should have a blocked reason');
  assert.equal(result.availableForPlanning, 0);
  assert.equal(result.remainingAfterPosted, 0);
});

test('partial hold, zero accept: blocked even though uninspected is zero', () => {
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 0, hold: 40, reject: 60 }),
    makeTotals()
  );
  assert.ok(result.blockedReason);
  assert.equal(result.availableForPlanning, 0);
});

// ─── 4. REWORK exclusion ─────────────────────────────────────────────────────
// REWORK comes from HOLD via hold_disposition_events.
// loadQcBreakdown subtracts disposed qty from hold → net_hold = hold - disposed.
// When REWORK consumes all held qty, net_hold = 0 and accept qty is fully eligible.

test('REWORK scenario: all hold disposed → net hold=0, accept qty fully eligible', () => {
  // 100 received: 60 accepted, 40 held → 40 reworked (gross_hold=40, net_hold=0, disposed=40)
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 60, hold: 0, disposed: 40 }),
    makeTotals()
  );
  assert.equal(result.blockedReason, undefined);
  assert.equal(result.availableForPlanning, 60);
});

test('REWORK scenario: partial disposal → net hold remains, accept qty still eligible', () => {
  // 100 received: 60 accepted, 40 held → 20 reworked (gross_hold=40, net_hold=20, disposed=20)
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 60, hold: 20, disposed: 20 }),
    makeTotals()
  );
  // accept > 0: putaway is allowed for accepted qty even though hold > 0
  assert.equal(result.blockedReason, undefined, 'partial rework must not block accepted qty');
  assert.equal(result.availableForPlanning, 60);
});

// ─── 5. DISCARDED exclusion ──────────────────────────────────────────────────
// DISCARDED comes from HOLD via hold_disposition_events, same mechanism as REWORK.

test('DISCARDED scenario: all hold disposed → net hold=0, accept qty eligible', () => {
  // 100 received: 60 accepted, 40 held → 40 discarded (gross_hold=40, net_hold=0, disposed=40)
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 60, hold: 0, disposed: 40 }),
    makeTotals()
  );
  assert.equal(result.blockedReason, undefined);
  assert.equal(result.availableForPlanning, 60);
});

test('DISCARDED scenario: partial disposal → net hold remains positive, accept qty still eligible', () => {
  // 100 received: 60 accepted, 40 held → 30 discarded (gross_hold=40, net_hold=10, disposed=30)
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 60, hold: 10, disposed: 30 }),
    makeTotals()
  );
  assert.equal(result.blockedReason, undefined, 'partial discard must not block accepted qty');
  assert.equal(result.availableForPlanning, 60);
});

// ─── 6. Mixed allocations: only AVAILABLE participates ───────────────────────

test('mixed: accept=50 hold=30 reject=20 → only 50 eligible', () => {
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 50, hold: 30, reject: 20 }),
    makeTotals()
  );
  assert.equal(result.blockedReason, undefined);
  assert.equal(result.availableForPlanning, 50);
});

test('mixed with rework: accept=50 hold=0(net) reject=20 → 50 eligible', () => {
  // 100 received: 50 accepted, 30 held (20 reworked → net 10), 20 rejected
  // gross_hold=30, net_hold=10, disposed=20
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 50, hold: 10, reject: 20, disposed: 20 }),
    makeTotals()
  );
  assert.equal(result.blockedReason, undefined);
  assert.equal(result.availableForPlanning, 50);
});

// ─── 7. Uninspected blocks putaway ───────────────────────────────────────────

test('uninspected qty > 0: putaway is blocked', () => {
  // 100 received, only 60 inspected (40 uninspected)
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 60, hold: 0, reject: 0 }),
    makeTotals()
  );
  assert.ok(result.blockedReason, 'uninspected qty should block putaway');
  assert.equal(result.availableForPlanning, 0);
});

test('no QC events: fully uninspected, putaway is blocked', () => {
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 0, hold: 0, reject: 0 }),
    makeTotals()
  );
  assert.ok(result.blockedReason);
  assert.equal(result.availableForPlanning, 0);
});

// ─── 8. Conservation: already-posted qty reduces availableForPlanning ────────

test('conservation: posted qty reduces availableForPlanning, not qcAllowed', () => {
  // 100 received, 60 accepted, 30 already put away
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 60, hold: 40 }),
    makeTotals({ posted: 30 })
  );
  assert.equal(result.blockedReason, undefined);
  assert.equal(result.remainingAfterPosted, 30, 'remaining = 60 - 30 = 30');
  assert.equal(result.availableForPlanning, 30);
});

test('conservation: fully posted, nothing remaining for new putaway', () => {
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 60, hold: 40 }),
    makeTotals({ posted: 60 })
  );
  assert.equal(result.remainingAfterPosted, 0);
  assert.equal(result.availableForPlanning, 0);
});

test('conservation: pending qty excluded from availableForPlanning', () => {
  // 60 accepted, 20 posted, 10 pending in another putaway
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 60, hold: 40 }),
    makeTotals({ posted: 20, pending: 10 })
  );
  assert.equal(result.remainingAfterPosted, 40, 'remaining after posted = 60 - 20 = 40');
  assert.equal(result.availableForPlanning, 30, 'available for new planning = 60 - 20 - 10 = 30');
});

// ─── 9. qcAllowed never exceeds receiptQty or accept ────────────────────────

test('qcAllowed bounded by both receiptQty and accept', () => {
  // Reject reduces effective qty but qcAllowed is min(receiptQty - rejected, accept)
  const result = calculatePutawayAvailability(
    makeContext(100),
    makeQc({ accept: 80, hold: 0, reject: 30 }),
    makeTotals()
  );
  // receiptQty - rejected = 70, accept = 80 → qcAllowed = min(70, 80) = 70
  assert.equal(result.availableForPlanning, 70);
});
