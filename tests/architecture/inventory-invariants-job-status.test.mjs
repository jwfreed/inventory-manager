import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const invariantsModulePath = require.resolve('../../src/jobs/inventoryInvariants.job.ts');
const dbModulePath = require.resolve('../../src/db.ts');
const eventsModulePath = require.resolve('../../src/lib/events.ts');

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous.entries()) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

function withMockedInvariantModule({ modeRef, tenantId, tenantSlug }, fn) {
  const originalDbCache = require.cache[dbModulePath];
  const originalEventsCache = require.cache[eventsModulePath];
  const originalInvariantsCache = require.cache[invariantsModulePath];

  const emptyResult = { rows: [], rowCount: 0 };
  const zeroCountResult = { rows: [{ count: '0' }], rowCount: 1 };

  const runQuery = async (config, params) => {
    const sql = typeof config === 'string' ? config : String(config?.text ?? '');
    const values = typeof config === 'string' ? params : config?.values;

    if (/^\s*SET\s+/i.test(sql) || /^\s*RESET\s+/i.test(sql)) {
      return emptyResult;
    }
    if (sql.includes('FROM tenants WHERE id = ANY($1)')) {
      const requestedTenantIdsRaw = Array.isArray(values?.[0]) ? values[0] : [values?.[0] ?? tenantId];
      const requestedTenantIds = requestedTenantIdsRaw
        .map((id) => String(id ?? '').trim())
        .filter(Boolean);
      const effectiveTenantIds = requestedTenantIds.length > 0 ? requestedTenantIds : [tenantId];
      const rows = effectiveTenantIds.map((id, index) => ({
        id,
        name: 'Invariant Tenant',
        slug: effectiveTenantIds.length === 1 ? tenantSlug : `${tenantSlug}-${index + 1}`
      }));
      return {
        rows,
        rowCount: rows.length
      };
    }
    if (modeRef.mode === 'fail' && sql.includes('FROM purchase_order_receipt_lines')) {
      const error = new Error('canceling statement due to statement timeout');
      error.code = '57014';
      throw error;
    }
    if (/\sAS\s+count\b/i.test(sql)) {
      return zeroCountResult;
    }
    if (sql.includes('resolve_warehouse_for_location')) {
      return emptyResult;
    }
    return emptyResult;
  };

  const dbMock = {
    query: (config, params) => runQuery(config, params),
    pool: {
      connect: async () => ({
        query: (config, params) => runQuery(config, params),
        release: () => undefined
      })
    }
  };

  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: dbMock
  };
  require.cache[eventsModulePath] = {
    id: eventsModulePath,
    filename: eventsModulePath,
    loaded: true,
    exports: { emitEvent: () => undefined }
  };
  delete require.cache[invariantsModulePath];

  const invariantsModule = require(invariantsModulePath);
  return Promise.resolve()
    .then(() => fn(invariantsModule))
    .finally(() => {
      if (originalDbCache) {
        require.cache[dbModulePath] = originalDbCache;
      } else {
        delete require.cache[dbModulePath];
      }
      if (originalEventsCache) {
        require.cache[eventsModulePath] = originalEventsCache;
      } else {
        delete require.cache[eventsModulePath];
      }
      if (originalInvariantsCache) {
        require.cache[invariantsModulePath] = originalInvariantsCache;
      } else {
        delete require.cache[invariantsModulePath];
      }
    });
}

test('non-strict failure preserves status error and subsequent clean run clears it', async () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const modeRef = { mode: 'fail' };

  await withEnv(
    {
      INVARIANTS_MAX_ATTEMPTS_PER_TENANT: '2',
      INVARIANTS_RETRY_BASE_DELAY_MS: '1',
      INVARIANTS_RETRY_MAX_DELAY_MS: '1',
      INVARIANTS_MAX_TENANT_WALL_CLOCK_MS: '2000',
      INVARIANTS_STATEMENT_TIMEOUT_MS: '10',
      INVARIANTS_LOCK_TIMEOUT_MS: '10',
      INVARIANTS_QUERY_TIMEOUT_MS: '20'
    },
    async () => {
      await withMockedInvariantModule({ modeRef, tenantId, tenantSlug: 'status-test' }, async (job) => {
        const failedRun = await job.runInventoryInvariantCheck({ tenantIds: [tenantId], strict: false });
        assert.deepEqual(failedRun, []);

        const failedStatus = job.getInventoryInvariantJobStatus();
        assert.equal(failedStatus.isRunning, false);
        assert.equal(failedStatus.lastRunOk, false);
        assert.ok(failedStatus.lastRunTime instanceof Date);
        assert.equal(typeof failedStatus.lastRunDuration, 'number');
        assert.ok(failedStatus.lastRunError);
        assert.equal(failedStatus.lastRunError.tenantId, tenantId);
        assert.equal(failedStatus.lastRunError.tenantSlug, 'status-test');
        assert.equal(failedStatus.lastRunError.code, '57014');
        assert.equal(failedStatus.lastRunError.attempt, 2);
        assert.equal(Array.isArray(failedStatus.lastRunFailures), true);
        assert.equal(failedStatus.lastRunFailures.length, 1);

        modeRef.mode = 'ok';
        const cleanRun = await job.runInventoryInvariantCheck({ tenantIds: [tenantId], strict: false });
        assert.equal(cleanRun.length, 1);

        const cleanStatus = job.getInventoryInvariantJobStatus();
        assert.equal(cleanStatus.isRunning, false);
        assert.equal(cleanStatus.lastRunOk, true);
        assert.ok(cleanStatus.lastRunTime instanceof Date);
        assert.equal(typeof cleanStatus.lastRunDuration, 'number');
        assert.equal(cleanStatus.lastRunError, null);
        assert.deepEqual(cleanStatus.lastRunFailures, []);
      });
    }
  );
});

test('lastRunFailures is capped and clean run resets capped status fields', async () => {
  const tenantIds = Array.from({ length: 6 }, (_, index) => (
    `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`
  ));
  const modeRef = { mode: 'fail' };
  const maxRecordedFailures = 3;

  await withEnv(
    {
      INVARIANTS_MAX_ATTEMPTS_PER_TENANT: '1',
      INVARIANTS_RETRY_BASE_DELAY_MS: '1',
      INVARIANTS_RETRY_MAX_DELAY_MS: '1',
      INVARIANTS_MAX_TENANT_WALL_CLOCK_MS: '2000',
      INVARIANTS_STATEMENT_TIMEOUT_MS: '10',
      INVARIANTS_LOCK_TIMEOUT_MS: '10',
      INVARIANTS_QUERY_TIMEOUT_MS: '20',
      INVARIANTS_MAX_RECORDED_FAILURES: String(maxRecordedFailures)
    },
    async () => {
      await withMockedInvariantModule(
        { modeRef, tenantId: tenantIds[0], tenantSlug: 'status-cap-test' },
        async (job) => {
          const failedRun = await job.runInventoryInvariantCheck({ tenantIds, strict: false });
          assert.deepEqual(failedRun, []);

          const failedStatus = job.getInventoryInvariantJobStatus();
          assert.equal(failedStatus.lastRunOk, false);
          assert.ok(failedStatus.lastRunError);
          assert.equal(failedStatus.lastRunFailures.length, maxRecordedFailures);
          assert.equal(failedStatus.failureCountRecorded, maxRecordedFailures);
          assert.equal(failedStatus.failureCountTotal, tenantIds.length);

          modeRef.mode = 'ok';
          const cleanRun = await job.runInventoryInvariantCheck({ tenantIds, strict: false });
          assert.equal(cleanRun.length, tenantIds.length);

          const cleanStatus = job.getInventoryInvariantJobStatus();
          assert.equal(cleanStatus.lastRunOk, true);
          assert.equal(cleanStatus.lastRunError, null);
          assert.deepEqual(cleanStatus.lastRunFailures, []);
          assert.equal(cleanStatus.failureCountRecorded, 0);
          assert.equal(cleanStatus.failureCountTotal, 0);
        }
      );
    }
  );
});
