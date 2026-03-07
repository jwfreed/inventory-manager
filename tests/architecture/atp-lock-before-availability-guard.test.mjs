import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ORDER_TO_CASH_SERVICE = path.resolve(process.cwd(), 'src/services/orderToCash.service.ts');
const INVENTORY_COMMAND_WRAPPER = path.resolve(process.cwd(), 'src/modules/platform/application/runInventoryCommand.ts');

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

function assertUsesMutationLocking(body, functionName) {
  const usesDirectLocks = /\bacquireAtpAdvisoryLocks\(/.test(body);
  const usesWrapper = /\brunInventoryCommand(?:<[^>]+>)?\(/.test(body);
  assert.ok(
    usesDirectLocks || usesWrapper,
    `expected ${functionName} to use runInventoryCommand() or acquireAtpAdvisoryLocks()`
  );
}

function assertAcquireBeforeAvailability(body, functionName) {
  if (body.includes('runInventoryCommand')) {
    return;
  }
  const acquireIndex = body.indexOf('acquireAtpAdvisoryLocks(');
  const availabilityIndex = body.indexOf('getCanonicalAvailability(');
  assert.notEqual(availabilityIndex, -1, `${functionName} must use canonical availability helper`);
  assert.notEqual(acquireIndex, -1, `${functionName} must acquire advisory locks`);
  assert.ok(
    acquireIndex < availabilityIndex,
    `${functionName} must acquire locks before canonical availability reads`
  );
}

test('ATP mutation entrypoints acquire advisory locks and canonical availability stays lock-guarded', async () => {
  const source = await readFile(ORDER_TO_CASH_SERVICE, 'utf8');
  const wrapperSource = await readFile(INVENTORY_COMMAND_WRAPPER, 'utf8');

  const mutationEntrypoints = [
    'createReservations',
    'allocateReservation',
    'cancelReservation',
    'fulfillReservation',
    'expireReservationsJob',
    'postShipment'
  ];
  for (const fnName of mutationEntrypoints) {
    const body = extractFunctionBody(source, 'export async function', fnName);
    assertUsesMutationLocking(body, fnName);
  }

  assert.match(
    extractFunctionBody(source, 'export async function', 'expireReservationsJob'),
    /\brunInventoryCommand(?:<[^>]+>)?\(/,
    'expireReservationsJob must use runInventoryCommand()'
  );
  assert.match(
    extractFunctionBody(source, 'export async function', 'postShipment'),
    /\brunInventoryCommand(?:<[^>]+>)?\(/,
    'postShipment must use runInventoryCommand()'
  );

  assert.match(
    wrapperSource,
    /\bacquireAtpLocks\(/,
    'runInventoryCommand() must acquire ATP locks before executing inventory mutations'
  );

  assertAcquireBeforeAvailability(
    extractFunctionBody(source, 'export async function', 'createReservations'),
    'createReservations'
  );
  assertAcquireBeforeAvailability(
    extractFunctionBody(source, 'export async function', 'postShipment'),
    'postShipment'
  );

  const availabilityHelperBody = extractFunctionBody(source, 'async function', 'getCanonicalAvailability');
  assert.match(
    availabilityHelperBody,
    /\bassertAtpLockHeldOrThrow\(/,
    'canonical availability helper must assert lock context'
  );

  const canonicalSqlMatches = source.match(/inventory_available_location_v/g) ?? [];
  assert.equal(
    canonicalSqlMatches.length,
    1,
    'canonical availability SQL should only live in the lock-guarded helper'
  );
});
