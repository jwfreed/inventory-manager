import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const RECEIPTS_SERVICE = path.resolve(process.cwd(), 'src/services/receipts.service.ts');

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

test('receipt mutations must use the canonical mutation shell', async () => {
  const source = await readFile(RECEIPTS_SERVICE, 'utf8');
  for (const functionName of ['createPurchaseOrderReceipt', 'voidReceipt']) {
    const body = extractFunctionBody(source, 'export async function', functionName);
    assert.match(body, /\brunInventoryCommand(?:<[^>]+>)?\(/, `${functionName} must use runInventoryCommand()`);
    assert.doesNotMatch(body, /\bwithTransactionRetry\(/, `${functionName} must not own a manual retry shell`);
    assert.doesNotMatch(body, /\bwithTransaction\(/, `${functionName} must not own a manual transaction shell`);
    assert.doesNotMatch(body, /\benqueueInventoryMovementPosted\(/, `${functionName} must not enqueue movement events directly`);
  }
});

test('receipt mutations must not use derived projections for correctness', async () => {
  const source = await readFile(RECEIPTS_SERVICE, 'utf8');
  const createBody = extractFunctionBody(source, 'export async function', 'createPurchaseOrderReceipt');
  const voidBody = extractFunctionBody(source, 'export async function', 'voidReceipt');

  assert.doesNotMatch(createBody, /\bgetInventoryBalance(?:ForUpdate)?\(/, 'receipt create must not read inventory_balance for correctness');
  assert.doesNotMatch(voidBody, /\bgetInventoryBalance(?:ForUpdate)?\(/, 'receipt void must not read inventory_balance for correctness');
  assert.doesNotMatch(createBody, /\bquantity_on_hand\b/, 'receipt create must not read items.quantity_on_hand for correctness');
  assert.doesNotMatch(createBody, /\baverage_cost\b/, 'receipt create must not read items.average_cost for correctness');
  assert.doesNotMatch(voidBody, /\bquantity_on_hand\b/, 'receipt void must not read items.quantity_on_hand for correctness');
  assert.doesNotMatch(voidBody, /\baverage_cost\b/, 'receipt void must not read items.average_cost for correctness');
});

test('receipt replay and reversal hardening stays on shared helpers', async () => {
  const source = await readFile(RECEIPTS_SERVICE, 'utf8');
  const createBody = extractFunctionBody(source, 'export async function', 'createPurchaseOrderReceipt');
  const voidBody = extractFunctionBody(source, 'export async function', 'voidReceipt');
  const reversalBody = extractFunctionBody(source, 'async function', 'insertReversalLinesAndCollectDeltas');

  assert.match(
    source,
    /\bbuildReceiptCreateReplayResult\([\s\S]*\bbuildPostedDocumentReplayResult\(/,
    'receipt create replay must use the shared replay helper'
  );
  assert.match(
    source,
    /\bbuildReceiptVoidReplayResult\([\s\S]*\bbuildPostedDocumentReplayResult\(/,
    'receipt void replay must use the shared replay helper'
  );
  assert.match(
    createBody,
    /\bpersistInventoryMovement\(/,
    'receipt create must persist a deterministic movement hash through the canonical movement writer'
  );
  assert.match(
    voidBody,
    /\bpersistInventoryMovement\(/,
    'receipt void must persist a deterministic movement hash through the canonical movement writer'
  );
  assert.match(
    reversalBody,
    /\bsortDeterministicMovementLines\(/,
    'receipt reversal line planning must be deterministic'
  );
  assert.doesNotMatch(
    reversalBody,
    /\bINSERT INTO\s+inventory_movement_lines\b/,
    'receipt reversal must not bulk-insert authoritative movement lines directly'
  );
});
