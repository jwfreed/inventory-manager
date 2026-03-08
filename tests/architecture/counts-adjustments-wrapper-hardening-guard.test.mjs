import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const COUNTS_SERVICE = path.resolve(process.cwd(), 'src/services/counts.service.ts');
const ADJUSTMENTS_POSTING_SERVICE = path.resolve(process.cwd(), 'src/services/adjustments/posting.service.ts');
const INVENTORY_COMMAND_WRAPPER = path.resolve(
  process.cwd(),
  'src/modules/platform/application/runInventoryCommand.ts'
);

function extractFunctionBody(source, signaturePrefix, functionName) {
  const marker = `${signaturePrefix} ${functionName}`;
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `expected function marker: ${marker}`);

  const paramsOpenIndex = source.indexOf('(', markerIndex);
  assert.notEqual(paramsOpenIndex, -1, `missing parameter list for ${functionName}`);

  let paramsDepth = 0;
  let paramsCloseIndex = -1;
  for (let i = paramsOpenIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        paramsCloseIndex = i;
        break;
      }
    }
  }
  assert.notEqual(paramsCloseIndex, -1, `missing closing parenthesis for ${functionName}`);

  const openBraceIndex = source.indexOf('{', paramsCloseIndex);
  assert.notEqual(openBraceIndex, -1, `missing opening brace for ${functionName}`);

  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBraceIndex + 1, i);
      }
    }
  }
  throw new Error(`failed to parse function body for ${functionName}`);
}

test('counts and adjustments must use the canonical mutation shell', async () => {
  const [countsSource, adjustmentsSource] = await Promise.all([
    readFile(COUNTS_SERVICE, 'utf8'),
    readFile(ADJUSTMENTS_POSTING_SERVICE, 'utf8')
  ]);

  const countBody = extractFunctionBody(countsSource, 'export async function', 'postInventoryCount');
  const adjustmentBody = extractFunctionBody(adjustmentsSource, 'export async function', 'postInventoryAdjustment');

  assert.match(countBody, /\brunInventoryCommand(?:<[^>]+>)?\(/, 'postInventoryCount must use runInventoryCommand()');
  assert.doesNotMatch(countBody, /\bwithTransactionRetry\(/, 'postInventoryCount must not own a manual retry shell');
  assert.doesNotMatch(countBody, /\bwithTransaction\(/, 'postInventoryCount must not own a manual transaction shell');
  assert.doesNotMatch(countBody, /\benqueueInventoryMovementPosted\(/, 'postInventoryCount must not enqueue movement events directly');

  assert.match(adjustmentBody, /\brunInventoryCommand(?:<[^>]+>)?\(/, 'postInventoryAdjustment must use runInventoryCommand()');
  assert.doesNotMatch(adjustmentBody, /\bwithTransactionRetry\(/, 'postInventoryAdjustment must not own a manual retry shell');
  assert.doesNotMatch(adjustmentBody, /\bwithTransaction\(/, 'postInventoryAdjustment must not own a manual transaction shell');
  assert.doesNotMatch(adjustmentBody, /\benqueueInventoryMovementPosted\(/, 'postInventoryAdjustment must not enqueue movement events directly');
});

test('counts and adjustments must not read derived projections for correctness', async () => {
  const [countsSource, adjustmentsSource] = await Promise.all([
    readFile(COUNTS_SERVICE, 'utf8'),
    readFile(ADJUSTMENTS_POSTING_SERVICE, 'utf8')
  ]);

  const countBody = extractFunctionBody(countsSource, 'export async function', 'postInventoryCount');
  const adjustmentBody = extractFunctionBody(adjustmentsSource, 'export async function', 'postInventoryAdjustment');

  for (const [body, label] of [
    [countBody, 'postInventoryCount'],
    [adjustmentBody, 'postInventoryAdjustment']
  ]) {
    assert.doesNotMatch(body, /\bgetInventoryBalance(?:ForUpdate)?\(/, `${label} must not read inventory_balance for correctness`);
    assert.doesNotMatch(body, /\bquantity_on_hand\b/, `${label} must not read items.quantity_on_hand for correctness`);
    assert.doesNotMatch(body, /\baverage_cost\b/, `${label} must not read items.average_cost for correctness`);
  }
});

test('wrapper-owned event ordering and lock sorting remain centralized', async () => {
  const source = await readFile(INVENTORY_COMMAND_WRAPPER, 'utf8');

  assert.match(
    source,
    /const sortedLockTargets = \[\.\.\.lockTargets\]\.sort\(compareInventoryCommandLockTarget\)/,
    'runInventoryCommand must sort lock targets deterministically before acquiring advisory locks'
  );

  const appendIndex = source.indexOf('appendInventoryEventsWithDispatch(');
  const projectionIndex = source.indexOf('for (const projectionOp of execution.projectionOps ?? [])');

  assert.notEqual(appendIndex, -1, 'runInventoryCommand must append authoritative events');
  assert.notEqual(projectionIndex, -1, 'runInventoryCommand must execute projection ops');
  assert.ok(appendIndex < projectionIndex, 'authoritative event append must precede projection ops');
});

test('count and adjustment posted or replay paths remain anchored to authoritative movement identity', async () => {
  const [countsSource, adjustmentsSource] = await Promise.all([
    readFile(COUNTS_SERVICE, 'utf8'),
    readFile(ADJUSTMENTS_POSTING_SERVICE, 'utf8')
  ]);

  assert.match(
    countsSource,
    /\basync function buildInventoryCountReplayResult\(/,
    'counts must centralize replay repair around authoritative movement identity'
  );
  assert.match(
    countsSource,
    /\bcycleCount\.status === 'posted' && cycleCount\.inventory_movement_id\b/,
    'counts must only treat posted state as authoritative when a movement id exists'
  );
  assert.match(
    countsSource,
    /\bauthoritativeMovementReady\(/,
    'counts replay handling must verify authoritative movement readiness'
  );

  assert.match(
    adjustmentsSource,
    /\basync function buildInventoryAdjustmentReplayResult\(/,
    'adjustments must centralize replay repair around authoritative movement identity'
  );
  assert.match(
    adjustmentsSource,
    /\badjustmentRow\.status === 'posted' && adjustmentRow\.inventory_movement_id\b/,
    'adjustments must only treat posted state as authoritative when a movement id exists'
  );
  assert.match(
    adjustmentsSource,
    /\bADJUSTMENT_POST_INCOMPLETE\b/,
    'adjustments must fail explicitly when status and authoritative movement state diverge'
  );
  assert.match(
    adjustmentsSource,
    /\bauthoritativeMovementReady\(/,
    'adjustments replay handling must verify authoritative movement readiness'
  );
});
