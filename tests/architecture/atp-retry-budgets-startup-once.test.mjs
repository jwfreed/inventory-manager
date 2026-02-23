import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  emitAtpRetryBudgetsEffectiveLogOnce,
  resolveAtpRetryBudgets
} = require('../../src/config/atpRetryBudgets.ts');

const LOG_ONCE_KEY = Symbol.for('siamaya.atpRetryBudgetsLogged');

function resetLogOnceState() {
  const globalState = globalThis;
  if (Object.prototype.hasOwnProperty.call(globalState, LOG_ONCE_KEY)) {
    delete globalState[LOG_ONCE_KEY];
  }
}

test('ATP retry budgets startup log emits exactly once per process', () => {
  resetLogOnceState();
  const budgets = resolveAtpRetryBudgets({
    env: { NODE_ENV: 'development' }
  });
  const messages = [];

  const first = emitAtpRetryBudgetsEffectiveLogOnce(budgets, (message) => messages.push(message));
  const second = emitAtpRetryBudgetsEffectiveLogOnce(budgets, (message) => messages.push(message));

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(messages.length, 1);

  const payload = JSON.parse(messages[0]);
  assert.equal(payload.code, 'ATP_RETRY_BUDGETS_EFFECTIVE');
  assert.equal(payload.serializableRetries, budgets.serializableRetries);
  assert.equal(payload.reservationCreateRetries, budgets.reservationCreateRetries);

  resetLogOnceState();
});

test('startup log remains suppressed when once-state already set', () => {
  resetLogOnceState();
  globalThis[LOG_ONCE_KEY] = true;
  const budgets = resolveAtpRetryBudgets({
    env: { NODE_ENV: 'development' }
  });
  const messages = [];

  const emitted = emitAtpRetryBudgetsEffectiveLogOnce(budgets, (message) => messages.push(message));

  assert.equal(emitted, false);
  assert.equal(messages.length, 0);
  resetLogOnceState();
});

