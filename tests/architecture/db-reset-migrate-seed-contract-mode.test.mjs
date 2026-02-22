import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  resolveFreshContractMode,
  assertPostSeedContract
} = require('../../scripts/db-reset-migrate-seed.ts');

test('fresh contract mode resolves from flag or env', () => {
  assert.equal(resolveFreshContractMode(['node', 'script.ts']), false);
  assert.equal(resolveFreshContractMode(['node', 'script.ts', '--fresh-contract']), true);
  assert.equal(
    resolveFreshContractMode(['node', 'script.ts'], { FRESH_DB_CONTRACT: 'true' }),
    true
  );
});

test('non-contract mode does not enforce global tenantCount=1', () => {
  assert.doesNotThrow(() =>
    assertPostSeedContract({
      freshContract: false,
      tenantCount: 3,
      receiveTransferSourceGapCount: 0
    })
  );
});

test('fresh-contract mode enforces tenantCount=1', () => {
  assert.throws(
    () =>
      assertPostSeedContract({
        freshContract: true,
        tenantCount: 2,
        receiveTransferSourceGapCount: 0
      }),
    /expected_tenant_count=1/
  );
});

test('source metadata gaps fail regardless of mode', () => {
  assert.throws(
    () =>
      assertPostSeedContract({
        freshContract: false,
        tenantCount: 2,
        receiveTransferSourceGapCount: 1
      }),
    /remaining_receive_transfer_source_gaps=1/
  );
});
