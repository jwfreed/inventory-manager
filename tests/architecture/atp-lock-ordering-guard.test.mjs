import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { buildAtpLockKeys } = require('../../src/domains/inventory/internal/atpLocks.ts');

const ORDER_TO_CASH_SERVICE = path.resolve(process.cwd(), 'src/services/orderToCash.service.ts');
const ATP_LOCKS_HELPER = path.resolve(process.cwd(), 'src/domains/inventory/internal/atpLocks.ts');

test('ATP mutation path keeps deterministic advisory lock ordering', async () => {
  const [serviceSource, helperSource] = await Promise.all([
    readFile(ORDER_TO_CASH_SERVICE, 'utf8'),
    readFile(ATP_LOCKS_HELPER, 'utf8')
  ]);

  assert.match(serviceSource, /from '\.\.\/domains\/inventory\/internal\/atpLocks'/);
  assert.match(serviceSource, /preparedLines\.sort\(compareReservationLockKey\)/);
  assert.match(serviceSource, /acquireAtpAdvisoryLocks\(/);
  assert.doesNotMatch(serviceSource, /pg_advisory_xact_lock/);
  assert.doesNotMatch(serviceSource, /hashtext\(/);

  assert.match(helperSource, /\bfunction stableHashInt32\(/);
  assert.match(helperSource, /\bexport function buildAtpLockKeys\(/);
  assert.match(helperSource, /\bexport async function acquireAtpLocks\(/);
  assert.match(helperSource, /\bexport const MAX_ATP_LOCK_TARGETS\s*=\s*5000/);
  assert.match(helperSource, /sortedTargets = Array\.from\(deduped\.values\(\)\)\.sort\(compareAtpLockTarget\)/);
  assert.match(helperSource, /FROM \(VALUES \$\{valueTuples\.join\(', '\)\}\) AS v\(key1, key2\)/);
  assert.match(helperSource, /pg_advisory_xact_lock\(v\.key1, v\.key2\)/);
  assert.match(helperSource, /ORDER BY v\.key1 ASC, v\.key2 ASC/);
});

test('ATP retry exhaustion is mapped to deterministic service code', async () => {
  const source = await readFile(ORDER_TO_CASH_SERVICE, 'utf8');

  assert.match(source, /ATP_CONCURRENCY_EXHAUSTED/);
  assert.match(source, /withAtpRetryHandling\(/);
  assert.match(source, /ATP_INSUFFICIENT_AVAILABLE/);
});

test('ATP mutation paths acquire locks before canonical availability reads', async () => {
  const source = await readFile(ORDER_TO_CASH_SERVICE, 'utf8');

  assert.match(
    source,
    /preparedLines\.sort\(compareReservationLockKey\)[\s\S]*?acquireAtpAdvisoryLocks\([\s\S]*?getCanonicalAvailability\(/
  );
  assert.match(
    source,
    /shipmentLineContexts\.sort\([\s\S]*?acquireAtpAdvisoryLocks\([\s\S]*?getCanonicalAvailability\(/
  );
});

test('ATP advisory lock key derivation is deterministic and warehouse-scoped', () => {
  const base = {
    tenantId: '00000000-0000-0000-0000-000000000001',
    warehouseId: '00000000-0000-0000-0000-000000000010',
    itemId: '00000000-0000-0000-0000-000000000100'
  };

  const first = buildAtpLockKeys([base])[0];
  const second = buildAtpLockKeys([base])[0];
  assert.deepEqual(first, second, 'same tuple must produce stable lock keys');

  const differentWarehouse = buildAtpLockKeys([{ ...base, warehouseId: '00000000-0000-0000-0000-000000000011' }])[0];
  assert.notDeepEqual(
    [first.key1, first.key2],
    [differentWarehouse.key1, differentWarehouse.key2],
    'different warehouse must not share advisory lock key pair'
  );
});
