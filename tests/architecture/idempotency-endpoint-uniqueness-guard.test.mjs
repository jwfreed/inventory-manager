import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { IDEMPOTENCY_ENDPOINTS } = require('../../src/lib/idempotencyEndpoints.ts');

test('idempotency endpoint identifiers are unique and stable', () => {
  const entries = Object.entries(IDEMPOTENCY_ENDPOINTS);
  assert.ok(entries.length > 0, 'Expected IDEMPOTENCY_ENDPOINTS to contain at least one endpoint.');

  const duplicates = [];
  const byValue = new Map();
  for (const [name, value] of entries) {
    assert.equal(typeof value, 'string', `Endpoint ${name} must be a string.`);
    assert.ok(value.startsWith('/'), `Endpoint ${name} must be route-like (start with "/"): ${value}`);
    const previous = byValue.get(value);
    if (previous) {
      duplicates.push({ value, first: previous, second: name });
    } else {
      byValue.set(value, name);
    }
  }

  assert.equal(
    duplicates.length,
    0,
    [
      'IDEMPOTENCY_ENDPOINT_DUPLICATE_GUARD_FAILED: duplicate endpoint identifiers found.',
      ...duplicates.map((entry) => `${entry.first} and ${entry.second} share "${entry.value}"`)
    ].join('\n')
  );
});
