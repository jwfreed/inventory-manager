import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ORDER_TO_CASH_SERVICE = path.resolve(process.cwd(), 'src/services/orderToCash.service.ts');
const INVENTORY_COMMAND_WRAPPER = path.resolve(process.cwd(), 'src/modules/platform/application/runInventoryCommand.ts');
const INVENTORY_OUTBOX = path.resolve(process.cwd(), 'src/domains/inventory/outbox.ts');

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

test('expireReservationsJob and postShipment must run through the canonical mutation shell', async () => {
  const source = await readFile(ORDER_TO_CASH_SERVICE, 'utf8');
  for (const functionName of ['expireReservationsJob', 'postShipment']) {
    const body = extractFunctionBody(source, 'export async function', functionName);
    assert.match(body, /\brunInventoryCommand(?:<[^>]+>)?\(/, `${functionName} must use runInventoryCommand()`);
    assert.doesNotMatch(body, /\bwithTransactionRetry\(/, `${functionName} must not own a manual transaction retry shell`);
  }
});

test('expiry and shipment must not read projections for correctness', async () => {
  const source = await readFile(ORDER_TO_CASH_SERVICE, 'utf8');
  const expireBody = extractFunctionBody(source, 'export async function', 'expireReservationsJob');
  const shipmentBody = extractFunctionBody(source, 'export async function', 'postShipment');

  assert.doesNotMatch(expireBody, /\bgetInventoryBalance(?:ForUpdate)?\(/, 'expireReservationsJob must not read inventory_balance for correctness');
  assert.doesNotMatch(shipmentBody, /\bgetInventoryBalance(?:ForUpdate)?\(/, 'postShipment must not read inventory_balance for correctness');
  assert.doesNotMatch(shipmentBody, /\bquantity_on_hand\b/, 'postShipment must not read items.quantity_on_hand for correctness');
  assert.doesNotMatch(shipmentBody, /\baverage_cost\b/, 'postShipment must not read items.average_cost for correctness');
});

test('runInventoryCommand must append authoritative events before projection ops', async () => {
  const source = await readFile(INVENTORY_COMMAND_WRAPPER, 'utf8');
  const appendIndex = source.indexOf('appendInventoryEventsWithDispatch(');
  const projectionIndex = source.indexOf('for (const projectionOp of execution.projectionOps ?? [])');

  assert.notEqual(appendIndex, -1, 'runInventoryCommand must append authoritative events');
  assert.notEqual(projectionIndex, -1, 'runInventoryCommand must execute projection ops');
  assert.ok(appendIndex < projectionIndex, 'authoritative event append must precede projection ops');
});

test('inventory domain event helpers must preserve stable aggregate identity', async () => {
  const source = await readFile(INVENTORY_OUTBOX, 'utf8');
  assert.match(
    source,
    /aggregateType:\s*'inventory_movement'[\s\S]*aggregateId:\s*movementId/,
    'movement events must use stable movementId aggregate ids'
  );
  assert.match(
    source,
    /aggregateType:\s*'inventory_reservation'[\s\S]*aggregateId:\s*reservationId/,
    'reservation events must use stable reservationId aggregate ids'
  );
});
