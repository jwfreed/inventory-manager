import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const RESERVATION_SERVICE = path.resolve(
  process.cwd(),
  'src/services/inventoryReservation.service.ts'
);
const TRIGGER_MIGRATION = path.resolve(
  process.cwd(),
  'src/migrations/1775300001000_work_order_reservation_reopen_trigger_v2.ts'
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

test('void reservation restore uses direct updates and never deletes reservation rows', async () => {
  const source = await readFile(RESERVATION_SERVICE, 'utf8');
  const restoreBody = extractFunctionBody(source, 'export async function', 'restoreReservationsForVoid');

  assert.doesNotMatch(source, /\brebuildReservationAsReserved\b/);
  assert.doesNotMatch(restoreBody, /DELETE FROM inventory_reservations/);
  assert.match(
    restoreBody,
    /UPDATE inventory_reservations[\s\S]*SET quantity_fulfilled = \$1/,
    'restoreReservationsForVoid must reopen reservations with direct UPDATE'
  );
});

test('reservation trigger v2 derives work-order active status in the database and blocks non-restore reopen paths', async () => {
  const source = await readFile(TRIGGER_MIGRATION, 'utf8');

  assert.match(source, /\benforce_reservation_status_transition_v2\b/);
  assert.match(source, /NEW\.status := derived_status/);
  assert.match(source, /NEW\.demand_type = 'work_order_component'/);
  assert.match(source, /ELSIF new_fulfilled < old_fulfilled THEN/);
  assert.match(source, /RAISE EXCEPTION 'RESERVATION_TERMINAL_STATE'/);
});
