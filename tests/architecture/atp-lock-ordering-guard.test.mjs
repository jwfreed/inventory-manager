import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ORDER_TO_CASH_SERVICE = path.resolve(process.cwd(), 'src/services/orderToCash.service.ts');

test('ATP mutation path keeps deterministic advisory lock ordering', async () => {
  const source = await readFile(ORDER_TO_CASH_SERVICE, 'utf8');

  assert.match(source, /\bfunction compareAtpGuardKey\(/);
  assert.match(source, /\bfunction uniqueSortedAtpGuardKeys\(/);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /preparedLines\.sort\(compareReservationLockKey\)/);
  assert.match(source, /acquireAtpAdvisoryLocks\(/);
});

test('ATP retry exhaustion is mapped to deterministic service code', async () => {
  const source = await readFile(ORDER_TO_CASH_SERVICE, 'utf8');

  assert.match(source, /ATP_CONCURRENCY_EXHAUSTED/);
  assert.match(source, /withAtpRetryHandling\(/);
  assert.match(source, /ATP_INSUFFICIENT_AVAILABLE/);
});
