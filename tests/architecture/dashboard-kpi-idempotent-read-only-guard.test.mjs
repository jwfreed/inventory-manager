import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const FILE_PATH = path.resolve(process.cwd(), 'src/services/dashboardKpi.service.ts');

test('dashboard KPI compute must stay idempotent and inventory-read-only', async () => {
  const source = await readFile(FILE_PATH, 'utf8');

  assert.match(
    source,
    /pg_advisory_xact_lock/i,
    'Expected advisory lock usage to serialize same-fingerprint retries.',
  );

  assert.match(
    source,
    /notes LIKE/i,
    'Expected run fingerprint lookup in persisted KPI runs.',
  );

  const forbiddenInventoryWrites = [
    /insert\s+into\s+inventory_/i,
    /update\s+inventory_/i,
    /delete\s+from\s+inventory_/i,
  ];

  for (const pattern of forbiddenInventoryWrites) {
    assert.ok(!pattern.test(source), `Forbidden inventory write detected in dashboard KPI service: ${pattern}`);
  }
});
