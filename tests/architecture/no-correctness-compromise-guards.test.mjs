import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const GUARDED_MODULES = [
  'src/services/warehouseDefaults.service.ts',
  'src/config/warehouseDefaultsStartup.ts',
  'src/observability/warehouseDefaults.events.ts',
  'tests/api/helpers/testServer.mjs'
];

const FORBIDDEN_PATTERNS = [
  {
    name: 'inventory-posting-import',
    regex: /from\s+['"][^'"]*(transfers|counts|adjustments|receipts|putaways|closeout|orderToCash|workOrderExecution)\.service[^'"]*['"]/
  },
  {
    name: 'ledger-import',
    regex: /from\s+['"][^'"]*ledger\.service[^'"]*['"]/
  },
  {
    name: 'costing-import',
    regex: /from\s+['"][^'"]*(costLayers|costing|transferCosting|costRollUp)\.service[^'"]*['"]/
  },
  {
    name: 'availability-recompute-import',
    regex: /from\s+['"][^'"]*(atp|inventorySummary)\.service[^'"]*['"]/
  },
  {
    name: 'availability-recompute-call',
    regex: /\bgetAvailableToPromise(?:Detail)?\s*\(/
  }
];

function findViolations(source) {
  return FORBIDDEN_PATTERNS.filter((pattern) => pattern.regex.test(source)).map((pattern) => pattern.name);
}

test('warehouse defaults/startup/harness modules must not depend on ledger/cost/availability correctness paths', async () => {
  const violations = [];

  for (const relativePath of GUARDED_MODULES) {
    const source = await readFile(path.resolve(process.cwd(), relativePath), 'utf8');
    const matched = findViolations(source);
    for (const pattern of matched) {
      violations.push({ relativePath, pattern });
    }
  }

  assert.equal(
    violations.length,
    0,
    [
      'NO_CORRECTNESS_COMPROMISE_GUARD_FAILED: startup/defaults/harness modules imported forbidden correctness paths.',
      ...violations.map((row) => `${row.relativePath} [${row.pattern}]`)
    ].join('\n')
  );
});
