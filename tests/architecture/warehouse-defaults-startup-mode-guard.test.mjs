import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  resolveWarehouseDefaultsStartupMode,
  buildStructuredStartupError,
  logStructuredStartupFailure,
  WAREHOUSE_DEFAULTS_REPAIR_HINT
} = require('../../src/config/warehouseDefaultsStartup.ts');

test('non-test startup defaults repair to false when unset', () => {
  const env = { NODE_ENV: 'production' };
  const mode = resolveWarehouseDefaultsStartupMode({
    argv: ['node', 'src/server.ts'],
    env,
    nodeEnv: 'production'
  });

  assert.equal(mode.cliRepairDefaults, false);
  assert.equal(mode.startupRepairMode, undefined);
  assert.equal(mode.defaultsRepairEnv, 'false');
  assert.equal(env.WAREHOUSE_DEFAULTS_REPAIR, 'false');
});

test('startup without --repair-defaults does not enable repair implicitly', () => {
  const env = { NODE_ENV: 'development' };
  const mode = resolveWarehouseDefaultsStartupMode({
    argv: ['node', 'src/server.ts', '--port=3000'],
    env,
    nodeEnv: 'development'
  });

  assert.equal(mode.cliRepairDefaults, false);
  assert.equal(mode.startupRepairMode, undefined);
  assert.notEqual(env.WAREHOUSE_DEFAULTS_REPAIR, 'true');
});

test('development auto repair can be explicitly enabled via DEV_AUTO_REPAIR_DEFAULTS=true', () => {
  const env = { NODE_ENV: 'development', DEV_AUTO_REPAIR_DEFAULTS: 'true' };
  const mode = resolveWarehouseDefaultsStartupMode({
    argv: ['node', 'src/server.ts'],
    env,
    nodeEnv: 'development'
  });

  assert.equal(mode.cliRepairDefaults, false);
  assert.equal(mode.defaultsRepairEnv, 'true');
  assert.equal(env.WAREHOUSE_DEFAULTS_REPAIR, 'true');
});

test('production ignores DEV_AUTO_REPAIR_DEFAULTS and remains fail-loud by default', () => {
  const env = { NODE_ENV: 'production', DEV_AUTO_REPAIR_DEFAULTS: 'true' };
  const mode = resolveWarehouseDefaultsStartupMode({
    argv: ['node', 'src/server.ts'],
    env,
    nodeEnv: 'production'
  });

  assert.equal(mode.cliRepairDefaults, false);
  assert.equal(mode.defaultsRepairEnv, 'false');
  assert.equal(env.WAREHOUSE_DEFAULTS_REPAIR, 'false');
});

test('startup --repair-defaults explicitly enables repair mode', () => {
  const env = { NODE_ENV: 'production', WAREHOUSE_DEFAULTS_REPAIR: 'false' };
  const mode = resolveWarehouseDefaultsStartupMode({
    argv: ['node', 'src/server.ts', '--repair-defaults'],
    env,
    nodeEnv: 'production'
  });

  assert.equal(mode.cliRepairDefaults, true);
  assert.equal(mode.startupRepairMode, true);
  assert.equal(env.WAREHOUSE_DEFAULTS_REPAIR, 'true');
});

test('dev:watch enables explicit dev-only auto-repair toggle and start script remains unchanged', async () => {
  const packageJson = JSON.parse(await readFile(path.resolve(process.cwd(), 'package.json'), 'utf8'));
  const devWatch = String(packageJson?.scripts?.['dev:watch'] ?? '');
  const start = String(packageJson?.scripts?.start ?? '');

  assert.match(devWatch, /\bDEV_AUTO_REPAIR_DEFAULTS=true\b/);
  assert.doesNotMatch(start, /\bDEV_AUTO_REPAIR_DEFAULTS=true\b/);
  assert.doesNotMatch(start, /\bWAREHOUSE_DEFAULTS_REPAIR=true\b/);
});

test('structured startup logging includes code and details JSON', () => {
  const messages = [];
  const error = { code: 'WAREHOUSE_DEFAULT_INVALID', details: { tenantId: 't1', warehouseId: 'w1' } };

  logStructuredStartupFailure(error, (message) => messages.push(message), {
    env: { WAREHOUSE_DEFAULTS_REPAIR: 'true' }
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0], /Startup failed structured:/);
  const serialized = messages[0].replace('Startup failed structured: ', '');
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.code, 'WAREHOUSE_DEFAULT_INVALID');
  assert.deepEqual(parsed.details, { tenantId: 't1', warehouseId: 'w1' });
});

test('structured startup logging is silent when code/details are absent', () => {
  const messages = [];
  logStructuredStartupFailure(new Error('plain start failure'), (message) => messages.push(message));
  assert.equal(messages.length, 0);
});

test('structured startup helper returns stable shape', () => {
  assert.deepEqual(buildStructuredStartupError({ code: 'X', details: { ok: true } }), {
    code: 'X',
    details: { ok: true }
  });
  assert.deepEqual(buildStructuredStartupError({}), {
    code: null,
    details: null
  });
});

test('structured startup error includes repair hint for defaults errors when repair is off', () => {
  const structured = buildStructuredStartupError(
    { code: 'WAREHOUSE_DEFAULT_INVALID', details: { tenantId: 't1' } },
    { env: { WAREHOUSE_DEFAULTS_REPAIR: 'false' } }
  );
  assert.equal(structured.code, 'WAREHOUSE_DEFAULT_INVALID');
  assert.equal(structured.details?.tenantId, 't1');
  assert.equal(structured.details?.hint, WAREHOUSE_DEFAULTS_REPAIR_HINT);
});

test('structured startup error omits repair hint for defaults errors when repair is on', () => {
  const structured = buildStructuredStartupError(
    { code: 'WAREHOUSE_DEFAULT_INVALID', details: { tenantId: 't1' } },
    { env: { WAREHOUSE_DEFAULTS_REPAIR: 'true' } }
  );
  assert.equal(structured.code, 'WAREHOUSE_DEFAULT_INVALID');
  assert.equal(structured.details?.tenantId, 't1');
  assert.equal(structured.details?.hint, undefined);
});
