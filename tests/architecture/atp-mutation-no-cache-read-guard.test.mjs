import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MUTATION_MODULES = [
  'src/services/orderToCash.service.ts',
  'src/routes/orderToCash.routes.ts',
  'src/routes/orderToCash.shipmentConflicts.ts'
];

const FORBIDDEN_PATTERNS = [
  {
    name: 'atp-cache-read-import',
    regex: /\bimport\s*\{[^}]*\bgetAtpCacheValue\b[^}]*\}\s*from\s*['"][^'"]*atpCache\.service['"]/
  },
  {
    name: 'atp-cache-read-call',
    regex: /\bgetAtpCacheValue(?:<[^>]+>)?\s*\(/
  },
  {
    name: 'raw-atp-cache-get-call',
    regex: /\batpCache\.get\s*\(/
  },
  {
    name: 'atp-service-read-call',
    regex: /\bgetAvailableToPromise(?:Detail)?\s*\(/
  }
];

function findPatternViolations(source, patterns) {
  return patterns.filter((pattern) => pattern.regex.test(source)).map((pattern) => pattern.name);
}

test('ATP mutation modules may invalidate cache but never read ATP cache values', async () => {
  const violations = [];
  for (const relativePath of MUTATION_MODULES) {
    const source = await readFile(path.resolve(process.cwd(), relativePath), 'utf8');
    const matched = findPatternViolations(source, FORBIDDEN_PATTERNS);
    for (const pattern of matched) {
      violations.push(`${relativePath} [${pattern}]`);
    }
  }

  assert.equal(
    violations.length,
    0,
    [
      'ATP_MUTATION_NO_CACHE_READ_GUARD_FAILED',
      ...violations
    ].join('\n')
  );
});

test('guard detector catches explicit ATP cache read regressions', () => {
  const regression = `
    import { getAtpCacheValue, invalidateAtpCacheForWarehouse } from './atpCache.service';
    export function brokenMutationRead(tenantId, warehouseId) {
      invalidateAtpCacheForWarehouse(tenantId, warehouseId);
      return getAtpCacheValue(tenantId, warehouseId, {});
    }
  `;
  const matched = findPatternViolations(regression, FORBIDDEN_PATTERNS);
  assert.ok(matched.includes('atp-cache-read-import'));
  assert.ok(matched.includes('atp-cache-read-call'));
});
