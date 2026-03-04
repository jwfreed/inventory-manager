import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { canonicalizeRequiredUom } = require('../../src/services/uomCanonical.service.ts');

test('canonicalizeRequiredUom trims surrounding whitespace', () => {
  assert.equal(canonicalizeRequiredUom('  EA  '), 'EA');
});

test('canonicalizeRequiredUom throws UOM_REQUIRED for blank values', () => {
  assert.throws(
    () => canonicalizeRequiredUom('   '),
    (error) => String(error?.message ?? '') === 'UOM_REQUIRED'
  );
});
