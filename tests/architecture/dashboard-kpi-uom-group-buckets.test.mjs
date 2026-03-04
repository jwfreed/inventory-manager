import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://localhost:5432/postgres';
}

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  selectUomDiagnosticsForKpi,
  summarizeDistinctUomDiagnosticGroups
} = require('../../src/services/dashboardKpi.service.ts');

test('summarizeDistinctUomDiagnosticGroups counts distinct groups and splits watch/action', () => {
  const result = summarizeDistinctUomDiagnosticGroups([
    {
      itemId: 'item-1',
      locationId: 'loc-1',
      status: 'LEGACY_FALLBACK_USED'
    },
    {
      itemId: 'item-1',
      locationId: 'loc-1',
      status: 'LEGACY_FALLBACK_USED'
    },
    {
      itemId: 'item-2',
      locationId: 'loc-2',
      status: 'INCONSISTENT'
    }
  ]);

  assert.equal(result.totalGroups, 2);
  assert.equal(result.watchGroups, 1);
  assert.equal(result.actionGroups, 1);
});

test('summarizeDistinctUomDiagnosticGroups upgrades mixed-severity group to action', () => {
  const result = summarizeDistinctUomDiagnosticGroups([
    {
      itemId: 'item-1',
      locationId: 'loc-1',
      status: 'LEGACY_FALLBACK_USED'
    },
    {
      itemId: 'item-1',
      locationId: 'loc-1',
      status: 'DIMENSION_MISMATCH'
    }
  ]);

  assert.equal(result.totalGroups, 1);
  assert.equal(result.watchGroups, 0);
  assert.equal(result.actionGroups, 1);
});

test('selectUomDiagnosticsForKpi prefers canonical diagnostics and falls back to alias', () => {
  const canonical = [
    {
      itemId: 'item-1',
      locationId: 'loc-1',
      status: 'INCONSISTENT'
    }
  ];
  const alias = [
    {
      itemId: 'item-2',
      locationId: 'loc-2',
      status: 'LEGACY_FALLBACK_USED'
    }
  ];

  const preferred = selectUomDiagnosticsForKpi({
    uomNormalizationDiagnostics: canonical,
    uomInconsistencies: alias
  });
  assert.deepEqual(preferred, canonical);

  const fallback = selectUomDiagnosticsForKpi({
    uomNormalizationDiagnostics: [],
    uomInconsistencies: alias
  });
  assert.deepEqual(fallback, alias);
});
