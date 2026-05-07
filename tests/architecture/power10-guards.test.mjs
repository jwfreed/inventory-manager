import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts/check-power10-guards.mjs');
const FIXTURE_ROOT = path.join(ROOT, 'tests/fixtures/power10');

function runPower10Guard(scanRoots) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      POWER10_SCAN_ROOTS: scanRoots.map((scanRoot) => path.join(FIXTURE_ROOT, scanRoot)).join(path.delimiter)
    }
  });
}

test('Power10 guard accepts bounded retry and annotated bounded patterns', () => {
  const result = runPower10Guard(['pass']);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Power10 guard check passed/);
});

test('Power10 guard rejects unannotated while true loops', () => {
  const result = runPower10Guard(['fail/unbounded-loop.ts']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /POWER10_UNBOUNDED_LOOP/);
});

test('Power10 guard rejects empty catch blocks without annotation', () => {
  const result = runPower10Guard(['fail/empty-catch.ts']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /POWER10_EMPTY_CATCH/);
});

test('Power10 guard rejects ts-ignore without a Power10 reason', () => {
  const result = runPower10Guard(['fail/ts-ignore.ts']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /POWER10_TS_IGNORE/);
});

test('Power10 guard rejects direct writes to protected inventory tables outside the allowlist', () => {
  const result = runPower10Guard(['fail/direct-inventory-write.ts']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /POWER10_DIRECT_INVENTORY_WRITE/);
});

test('Power10 guard rejects obvious unbounded Promise.all rows mapping', () => {
  const result = runPower10Guard(['fail/src/unbounded-promise-all.ts']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /POWER10_UNBOUNDED_BATCH_PROMISES/);
});
