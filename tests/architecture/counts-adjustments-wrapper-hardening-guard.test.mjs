import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

const SRC_ROOT = path.resolve(process.cwd(), 'src');
const COUNTS_SERVICE = path.resolve(process.cwd(), 'src/services/counts.service.ts');
const ADJUSTMENTS_POSTING_SERVICE = path.resolve(process.cwd(), 'src/services/adjustments/posting.service.ts');
const INVENTORY_COMMAND_WRAPPER = path.resolve(
  process.cwd(),
  'src/modules/platform/application/runInventoryCommand.ts'
);
const INVENTORY_MUTATION_SUPPORT = path.resolve(
  process.cwd(),
  'src/modules/platform/application/inventoryMutationSupport.ts'
);

function extractFunctionBody(source, functionName) {
  const markers = [
    `export async function ${functionName}`,
    `async function ${functionName}`,
    `function ${functionName}`
  ];
  const marker = markers
    .map((candidate) => ({ candidate, index: source.indexOf(candidate) }))
    .find((candidate) => candidate.index !== -1);

  assert.ok(marker, `expected function marker: ${functionName}`);

  const paramsOpenIndex = source.indexOf('(', marker.index);
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

  let openBraceIndex = -1;
  let inReturnType = false;
  let angleDepth = 0;
  let typeBraceDepth = 0;
  let lastNonWhitespaceChar = '';

  for (let i = paramsCloseIndex + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === ':' && !inReturnType && !lastNonWhitespaceChar) {
      inReturnType = true;
      lastNonWhitespaceChar = char;
      continue;
    }
    if (!inReturnType && /\s/.test(char)) {
      continue;
    }
    if (!inReturnType && char === '{') {
      openBraceIndex = i;
      break;
    }
    if (inReturnType) {
      if (char === '<') {
        angleDepth += 1;
      } else if (char === '>') {
        angleDepth = Math.max(0, angleDepth - 1);
      } else if (char === '{') {
        if (angleDepth === 0 && typeBraceDepth === 0 && lastNonWhitespaceChar !== ':') {
          openBraceIndex = i;
          break;
        }
        typeBraceDepth += 1;
      } else if (char === '}') {
        typeBraceDepth = Math.max(0, typeBraceDepth - 1);
      }
    }
    if (!/\s/.test(char)) {
      lastNonWhitespaceChar = char;
    }
  }
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

async function walkTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkTsFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

test('counts and adjustments must use the canonical mutation shell', async () => {
  const [countsSource, adjustmentsSource] = await Promise.all([
    readFile(COUNTS_SERVICE, 'utf8'),
    readFile(ADJUSTMENTS_POSTING_SERVICE, 'utf8')
  ]);

  const countBody = extractFunctionBody(countsSource, 'postInventoryCount');
  const adjustmentBody = extractFunctionBody(adjustmentsSource, 'postInventoryAdjustment');

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

  const countBody = extractFunctionBody(countsSource, 'postInventoryCount');
  const adjustmentBody = extractFunctionBody(adjustmentsSource, 'postInventoryAdjustment');

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

test('shared posted-document replay hardening anchors counts and adjustments to authoritative movements', async () => {
  const [countsSource, adjustmentsSource, supportSource] = await Promise.all([
    readFile(COUNTS_SERVICE, 'utf8'),
    readFile(ADJUSTMENTS_POSTING_SERVICE, 'utf8'),
    readFile(INVENTORY_MUTATION_SUPPORT, 'utf8')
  ]);

  const replayHelperBody = extractFunctionBody(supportSource, 'buildPostedDocumentReplayResult');
  const readinessIndex = replayHelperBody.indexOf('verifyAuthoritativeMovementReplayIntegrity(');
  const aggregateFetchIndex = replayHelperBody.indexOf('fetchAggregateView()');

  assert.notEqual(readinessIndex, -1, 'buildPostedDocumentReplayResult must verify authoritative movement integrity');
  assert.notEqual(aggregateFetchIndex, -1, 'buildPostedDocumentReplayResult must fetch the aggregate view');
  assert.ok(
    readinessIndex < aggregateFetchIndex,
    'buildPostedDocumentReplayResult must verify authoritative movement integrity before fetching aggregate state'
  );
  assert.match(
    supportSource,
    /REPLAY_CORRUPTION_DETECTED/,
    'shared replay hardening must fail closed with REPLAY_CORRUPTION_DETECTED'
  );
  assert.match(
    replayHelperBody,
    /inventoryEventVersionExists\([\s\S]*event\.aggregateType[\s\S]*event\.aggregateId[\s\S]*event\.eventType[\s\S]*event\.eventVersion/,
    'replay repair must key missing authoritative events by aggregate identity, event type, and version'
  );

  assert.match(
    countsSource,
    /\bbuildInventoryCountReplayResult\([\s\S]*buildPostedDocumentReplayResult\(/,
    'counts replay must delegate to the shared posted-document replay helper'
  );
  assert.match(
    countsSource,
    /\bcycleCount\.status === 'posted' && cycleCount\.inventory_movement_id\b/,
    'counts must only treat posted state as authoritative when a movement id exists'
  );
  assert.match(
    countsSource,
    /\bINV_COUNT_POST_IDEMPOTENCY_INCOMPLETE\b/,
    'counts must fail explicitly when posted status diverges from authoritative movement readiness'
  );
  assert.match(
    countsSource,
    /\bsortDeterministicMovementLines\(/,
    'counts must create movement lines in deterministic order'
  );
  assert.match(
    countsSource,
    /\bbuildMovementDeterministicHash\(/,
    'counts must persist deterministic movement hashes'
  );

  assert.match(
    adjustmentsSource,
    /\bbuildInventoryAdjustmentReplayResult\([\s\S]*buildPostedDocumentReplayResult\(/,
    'adjustments replay must delegate to the shared posted-document replay helper'
  );
  assert.match(
    adjustmentsSource,
    /\badjustmentRow\.status === 'posted' && adjustmentRow\.inventory_movement_id\b/,
    'adjustments must only treat posted state as authoritative when a movement id exists'
  );
  assert.match(
    adjustmentsSource,
    /\bbuildMovementDeterministicHash\(/,
    'adjustments must persist deterministic movement hashes'
  );
  assert.match(
    adjustmentsSource,
    /\bADJUSTMENT_POST_INCOMPLETE\b/,
    'adjustments must fail explicitly when posted status diverges from authoritative movement readiness'
  );
  assert.match(
    adjustmentsSource,
    /\bsortDeterministicMovementLines\(/,
    'adjustments must create movement lines in deterministic order'
  );
});

test('cycle count execution idempotency ledger remains transitional and isolated', async () => {
  const files = await walkTsFiles(SRC_ROOT);
  const usageFiles = [];

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    if (source.includes('cycle_count_post_executions')) {
      usageFiles.push(path.relative(process.cwd(), filePath));
    }
  }

  assert.deepEqual(
    usageFiles.sort(),
    [
      'src/migrations/1773710000000_cycle_count_posting_hardening.ts',
      'src/services/counts.service.ts'
    ],
    'cycle_count_post_executions must remain isolated to the transitional count posting flow and its migration'
  );
});
