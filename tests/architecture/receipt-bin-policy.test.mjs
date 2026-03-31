import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { assertInventoryBinResolutionPolicy } = require('../../src/domain/receipts/receiptBinModel.ts');

test('bin policy requires explicit instruction before default-bin resolution', () => {
  assert.throws(
    () => assertInventoryBinResolutionPolicy({ binId: null, allowDefaultBinResolution: false }),
    /RECEIPT_BIN_REQUIRED/
  );
});

test('bin policy distinguishes explicit bin selection from explicit default-bin resolution', () => {
  assert.equal(
    assertInventoryBinResolutionPolicy({ binId: 'bin-1', allowDefaultBinResolution: false }),
    'explicit'
  );
  assert.equal(
    assertInventoryBinResolutionPolicy({ binId: null, allowDefaultBinResolution: true }),
    'default_existing'
  );
});
