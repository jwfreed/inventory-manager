import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  formatMigrationVerifyTargetForMessage,
  buildMigrationVerifyFailure
} = require('../../scripts/verify-migration-state.ts');

test('migrate verify dry-run prints target dbName/host/port/user', () => {
  const env = {
    ...process.env,
    DATABASE_URL: 'postgres://verify_user@localhost:5432/verify_db',
    MIGRATE_VERIFY_DRY_RUN: 'true'
  };
  const result = spawnSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', 'scripts/verify-migration-state.ts'],
    { cwd: process.cwd(), env, encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const jsonLines = String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'))
    .map((line) => JSON.parse(line));

  const targetLine = jsonLines.find((line) => line.phase === 'migration_verify_target');
  assert.ok(targetLine, 'expected migration_verify_target JSON line');
  assert.equal(targetLine.dbName, 'verify_db');
  assert.equal(targetLine.host, 'localhost');
  assert.equal(targetLine.port, 5432);
  assert.equal(targetLine.user, 'verify_user');
});

test('migrate verify failure formatter includes target metadata', () => {
  const target = {
    dbName: 'inventory_manager_dev',
    host: '127.0.0.1',
    port: 5432,
    user: 'tester'
  };
  const message = formatMigrationVerifyTargetForMessage(target);
  assert.match(message, /dbName=inventory_manager_dev/);
  assert.match(message, /host=127.0.0.1/);
  assert.match(message, /port=5432/);
  assert.match(message, /user=tester/);

  const wrapped = buildMigrationVerifyFailure(target, new Error('MIGRATION_STATE_INCOMPLETE'));
  assert.equal(wrapped.code, 'MIGRATION_VERIFY_FAILED');
  assert.match(wrapped.message, /MIGRATION_STATE_INCOMPLETE/);
  assert.match(wrapped.message, /dbName=inventory_manager_dev/);
  assert.equal(wrapped.details?.dbName, 'inventory_manager_dev');
  assert.equal(wrapped.details?.host, '127.0.0.1');
  assert.equal(wrapped.details?.port, 5432);
  assert.equal(wrapped.details?.user, 'tester');
});
