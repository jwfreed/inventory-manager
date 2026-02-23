import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  resolveAtpRetryBudgets,
  ATP_RETRY_BUDGET_PROD_CAPS
} = require('../../src/config/atpRetryBudgets.ts');

test('ATP retry budgets resolve defaults with structured default flags', () => {
  const budgets = resolveAtpRetryBudgets({
    env: {
      NODE_ENV: 'development'
    },
    enforceProductionCaps: true
  });

  assert.equal(budgets.serializableRetries, 2);
  assert.equal(budgets.reservationCreateRetries, 6);
  assert.equal(budgets.defaultsUsed.serializableRetries, true);
  assert.equal(budgets.defaultsUsed.reservationCreateRetries, true);
});

test('production startup fails loud when ATP retry budgets exceed safety caps', () => {
  assert.throws(
    () =>
      resolveAtpRetryBudgets({
        env: {
          NODE_ENV: 'production',
          ATP_SERIALIZABLE_RETRIES: String(ATP_RETRY_BUDGET_PROD_CAPS.serializableRetries + 1),
          ATP_RESERVATION_CREATE_RETRIES: String(ATP_RETRY_BUDGET_PROD_CAPS.reservationCreateRetries + 1)
        },
        enforceProductionCaps: true
      }),
    (error) => {
      assert.equal(error?.code, 'ATP_RETRY_BUDGETS_UNSAFE_FOR_PRODUCTION');
      assert.equal(error?.details?.caps?.serializableRetries, ATP_RETRY_BUDGET_PROD_CAPS.serializableRetries);
      assert.equal(error?.details?.caps?.reservationCreateRetries, ATP_RETRY_BUDGET_PROD_CAPS.reservationCreateRetries);
      return true;
    }
  );
});

test('non-production allows elevated ATP retry budgets for controlled load testing', () => {
  const budgets = resolveAtpRetryBudgets({
    env: {
      NODE_ENV: 'test',
      ATP_SERIALIZABLE_RETRIES: '10',
      ATP_RESERVATION_CREATE_RETRIES: '50'
    },
    enforceProductionCaps: true
  });

  assert.equal(budgets.serializableRetries, 10);
  assert.equal(budgets.reservationCreateRetries, 50);
  assert.equal(budgets.defaultsUsed.serializableRetries, false);
  assert.equal(budgets.defaultsUsed.reservationCreateRetries, false);
});

test('invalid retry budget values fail loud with structured details', () => {
  assert.throws(
    () =>
      resolveAtpRetryBudgets({
        env: {
          NODE_ENV: 'development',
          ATP_SERIALIZABLE_RETRIES: 'abc'
        },
        enforceProductionCaps: true
      }),
    (error) => {
      assert.equal(error?.code, 'ATP_RETRY_BUDGETS_INVALID');
      assert.equal(error?.details?.field, 'ATP_SERIALIZABLE_RETRIES');
      assert.equal(error?.details?.reason, 'not_integer');
      return true;
    }
  );
});

