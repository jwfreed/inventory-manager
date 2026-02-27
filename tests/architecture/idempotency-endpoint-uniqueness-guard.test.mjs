import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { IDEMPOTENCY_ENDPOINTS } = require('../../src/lib/idempotencyEndpoints.ts');
const ENDPOINT_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

test('idempotency endpoint identifiers are unique and stable', () => {
  const entries = Object.entries(IDEMPOTENCY_ENDPOINTS);
  assert.ok(entries.length > 0, 'Expected IDEMPOTENCY_ENDPOINTS to contain at least one endpoint.');

  const duplicates = [];
  const formatViolations = [];
  const byValue = new Map();
  for (const [name, value] of entries) {
    assert.equal(typeof value, 'string', `Endpoint ${name} must be a string.`);
    if (!ENDPOINT_PATTERN.test(value)) {
      formatViolations.push({ name, value });
    }
    const previous = byValue.get(value);
    if (previous) {
      duplicates.push({ value, first: previous, second: name });
    } else {
      byValue.set(value, name);
    }
  }

  assert.equal(duplicates.length, 0, [
    'IDEMPOTENCY_ENDPOINT_DUPLICATE_GUARD_FAILED: duplicate endpoint identifiers found.',
    ...duplicates.map((entry) => `${entry.first} and ${entry.second} share "${entry.value}"`)
  ].join('\n'));
  assert.equal(formatViolations.length, 0, [
    'IDEMPOTENCY_ENDPOINT_NAMING_GUARD_FAILED: endpoint identifiers must match "domain.action" pattern',
    `Expected regex: ${ENDPOINT_PATTERN}`,
    ...formatViolations.map((entry) => `${entry.name}="${entry.value}"`)
  ].join('\n'));
});
