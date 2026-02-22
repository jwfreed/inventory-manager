import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { resolveSchedulerStartupMode } = require('../../src/config/schedulerStartup.ts');

test('scheduler remains enabled in production when RUN_INPROCESS_JOBS=true', () => {
  const mode = resolveSchedulerStartupMode({
    env: {
      NODE_ENV: 'production',
      RUN_INPROCESS_JOBS: 'true'
    },
    nodeEnv: 'production'
  });
  assert.equal(mode.runInProcessJobs, true);
  assert.equal(mode.schedulerEnabled, true);
});

test('scheduler is disabled by default in development unless ENABLE_SCHEDULER=true', () => {
  const disabledMode = resolveSchedulerStartupMode({
    env: {
      NODE_ENV: 'development',
      RUN_INPROCESS_JOBS: 'true'
    },
    nodeEnv: 'development'
  });
  assert.equal(disabledMode.runInProcessJobs, true);
  assert.equal(disabledMode.schedulerEnabled, false);

  const enabledMode = resolveSchedulerStartupMode({
    env: {
      NODE_ENV: 'development',
      RUN_INPROCESS_JOBS: 'true',
      ENABLE_SCHEDULER: 'true'
    },
    nodeEnv: 'development'
  });
  assert.equal(enabledMode.runInProcessJobs, true);
  assert.equal(enabledMode.schedulerEnabled, true);
});

test('scheduler stays disabled when RUN_INPROCESS_JOBS=false', () => {
  const mode = resolveSchedulerStartupMode({
    env: {
      NODE_ENV: 'production',
      RUN_INPROCESS_JOBS: 'false',
      ENABLE_SCHEDULER: 'true'
    },
    nodeEnv: 'production'
  });
  assert.equal(mode.runInProcessJobs, false);
  assert.equal(mode.schedulerEnabled, false);
});
