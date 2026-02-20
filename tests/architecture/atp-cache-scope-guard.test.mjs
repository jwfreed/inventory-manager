import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SRC_DIR = path.resolve(process.cwd(), 'src');
const ALLOWED_ATP_CACHE_INVALIDATE_FILES = [
  'src/services/atpCache.service.ts'
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

test('ATP cache usage must remain warehouse scoped and go through atpCache.service', async () => {
  const files = await listSourceFiles(SRC_DIR);
  const violations = [];

  for (const filePath of files) {
    const relativePath = path.relative(process.cwd(), filePath);
    const source = await readFile(filePath, 'utf8');

    for (const pattern of FORBIDDEN_PATTERNS) {
      if (!pattern.regex.test(source)) continue;
      if (
        pattern.name === 'raw-atpCache-invalidate'
        && ALLOWED_ATP_CACHE_INVALIDATE_FILES.includes(relativePath)
      ) {
        continue;
      }
      violations.push({ filePath: relativePath, pattern: pattern.name });
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
