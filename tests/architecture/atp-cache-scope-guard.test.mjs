import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SRC_DIR = path.resolve(process.cwd(), 'src');
const ALLOWED_ATP_CACHE_INVALIDATE_FILES = [
  'src/services/atpCache.service.ts'
];
const MUTATION_MODULES = [
  'src/services/orderToCash.service.ts',
  'src/services/transfers.service.ts',
  'src/routes/transfers.routes.ts',
  'src/services/counts.service.ts',
  'src/routes/counts.routes.ts',
  'src/services/qc.service.ts',
  'src/routes/qc.routes.ts'
];

const FORBIDDEN_PATTERNS = [
  {
    name: 'raw-atpCache-invalidate',
    regex: /\batpCache\.invalidate\s*\(/
  },
  {
    name: 'legacy-cacheKey-atp',
    regex: /\bcacheKey\s*\(\s*['"]atp['"]/
  }
];

const MUTATION_READ_FORBIDDEN_PATTERNS = [
  {
    name: 'atp-cache-read-import',
    regex: /\bimport\s*\{[^}]*\bgetAtpCacheValue\b[^}]*\}\s*from\s*['"][^'"]*atpCache\.service['"]/
  },
  {
    name: 'atp-cache-read-call',
    regex: /\bgetAtpCacheValue(?:<[^>]+>)?\s*\(/
  },
  {
    name: 'raw-atpCache-get',
    regex: /\batpCache\.get\s*\(/
  },
  {
    name: 'atp-service-read-call',
    regex: /\bgetAvailableToPromise(?:Detail)?\s*\(/
  }
];

async function listSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.mjs'))) {
      files.push(fullPath);
    }
  }
  return files;
}

function findPatternViolations(source, patterns) {
  return patterns.filter((pattern) => pattern.regex.test(source)).map((pattern) => pattern.name);
}

test('ATP cache usage must remain warehouse scoped and go through atpCache.service', async () => {
  const files = await listSourceFiles(SRC_DIR);
  const violations = [];

  for (const filePath of files) {
    const relativePath = path.relative(process.cwd(), filePath);
    const source = await readFile(filePath, 'utf8');
    const matched = findPatternViolations(source, FORBIDDEN_PATTERNS);

    for (const pattern of matched) {
      if (
        pattern === 'raw-atpCache-invalidate'
        && ALLOWED_ATP_CACHE_INVALIDATE_FILES.includes(relativePath)
      ) {
        continue;
      }
      violations.push({ filePath: relativePath, pattern });
    }
  }

  assert.equal(
    violations.length,
    0,
    [
      'ATP_CACHE_SCOPE_GUARD_FAILED: ATP cache invalidation/keying must be warehouse scoped via atpCache.service.',
      ...violations.map((v) => `${v.filePath} [${v.pattern}]`)
    ].join('\n')
  );
});

test('mutation modules may invalidate ATP cache but must never read ATP cache values', async () => {
  const violations = [];

  for (const relativePath of MUTATION_MODULES) {
    const source = await readFile(path.resolve(process.cwd(), relativePath), 'utf8');
    const matched = findPatternViolations(source, MUTATION_READ_FORBIDDEN_PATTERNS);
    for (const pattern of matched) {
      violations.push({ filePath: relativePath, pattern });
    }
  }

  assert.equal(
    violations.length,
    0,
    [
      'ATP_MUTATION_READ_GUARD_FAILED: mutation modules cannot read ATP cache values.',
      ...violations.map((v) => `${v.filePath} [${v.pattern}]`)
    ].join('\n')
  );
});

test('mutation guard detector flags ATP cache read regressions', () => {
  const regressionSource = `
    import { getAtpCacheValue, invalidateAtpCacheForWarehouse } from './atpCache.service';
    export function brokenMutationRead(tenantId, warehouseId) {
      invalidateAtpCacheForWarehouse(tenantId, warehouseId);
      return getAtpCacheValue(tenantId, warehouseId, {});
    }
  `;
  const matched = findPatternViolations(regressionSource, MUTATION_READ_FORBIDDEN_PATTERNS);
  assert.ok(matched.includes('atp-cache-read-import'));
  assert.ok(matched.includes('atp-cache-read-call'));
});
