import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const {
  handlePostShipmentConflict
} = require('../../src/routes/orderToCash.shipmentConflicts.ts');

function createMockResponse() {
  const state = { status: null, body: null };
  const res = {
    status(code) {
      state.status = code;
      return this;
    },
    json(payload) {
      state.body = payload;
      return this;
    }
  };
  return { res, state };
}

function assertConflictShape(state, expectedCode) {
  assert.equal(state.status, 409);
  assert.ok(state.body && typeof state.body === 'object', 'response body must be an object');
  assert.ok(state.body.error && typeof state.body.error === 'object', 'response.error must be an object');
  assert.equal(state.body.error.code, expectedCode);
  assert.equal(typeof state.body.error.code, 'string');
  assert.equal(typeof state.body.error.message, 'string');
  const details = state.body.error.details;
  assert.ok(details === undefined || (typeof details === 'object' && details !== null), 'error.details must be object or undefined');
}

function assertNoSensitiveKeys(value, path = 'error.details') {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(
      !/(stack|sql|query|error|exception|trace|driver|pgcode|sqlstate)/i.test(key),
      `sensitive key leaked at ${path}.${key}`
    );
    assertNoSensitiveKeys(nested, `${path}.${key}`);
  }
}

test('INSUFFICIENT_AVAILABLE_WITH_ALLOWANCE conflict serializes stable 409 shape', () => {
  const { res, state } = createMockResponse();
  const handled = handlePostShipmentConflict(
    {
      code: 'INSUFFICIENT_AVAILABLE_WITH_ALLOWANCE',
      message: 'custom message',
      details: {
        requested: 11,
        available: 10,
        stack: 'hidden',
        nested: {
          query: 'SELECT * FROM secret',
          kept: true
        }
      }
    },
    res
  );

  assert.equal(handled, true);
  assertConflictShape(state, 'INSUFFICIENT_AVAILABLE_WITH_ALLOWANCE');
  assertNoSensitiveKeys(state.body.error.details);
});

test('TX_RETRY_EXHAUSTED conflict serializes stable 409 shape with safe retry details', () => {
  const { res, state } = createMockResponse();
  const handled = handlePostShipmentConflict(
    {
      code: 'TX_RETRY_EXHAUSTED',
      message: 'could not serialize access due to concurrent update',
      stack: 'should never leak'
    },
    res
  );

  assert.equal(handled, true);
  assertConflictShape(state, 'TX_RETRY_EXHAUSTED');
  assertNoSensitiveKeys(state.body.error.details);
  assert.equal(state.body.error.details?.resource, 'inventory');
  assert.equal(state.body.error.details?.retryable, true);
  assert.equal(typeof state.body.error.details?.hint, 'string');
});

test('all known shipment conflict codes return 409 object-form error payload', () => {
  const scenarios = [
    { error: { code: 'INSUFFICIENT_STOCK' }, code: 'INSUFFICIENT_STOCK' },
    { error: { code: 'NEGATIVE_OVERRIDE_REQUIRES_REASON', details: { message: 'reason required' } }, code: 'NEGATIVE_OVERRIDE_REQUIRES_REASON' },
    { error: { message: 'SHIPMENT_CANCELED' }, code: 'SHIPMENT_CANCELED' },
    { error: { message: 'RESERVATION_INVALID_STATE' }, code: 'RESERVATION_INVALID_STATE' }
  ];

  for (const scenario of scenarios) {
    const { res, state } = createMockResponse();
    const handled = handlePostShipmentConflict(scenario.error, res);
    assert.equal(handled, true, `scenario not handled for ${scenario.code}`);
    assertConflictShape(state, scenario.code);
    assertNoSensitiveKeys(state.body.error.details);
  }
});
