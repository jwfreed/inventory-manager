import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const SRC_ROOT = path.resolve(process.cwd(), 'src');
const ALLOWED_FILES = new Set([
  path.resolve(process.cwd(), 'src/domains/inventory/internal/atpLocks.ts'),
  // Non-ATP template migration guard lock. Keep explicit allowlist so ATP paths stay single-source.
  path.resolve(process.cwd(), 'src/services/masterData.service.ts')
]);
const FORBIDDEN_PATTERNS = [
  /\bpg_advisory_xact_lock\b/,
  /\bpg_try_advisory_xact_lock\b/,
  /\bpg_advisory_lock\b/,
  /\bpg_try_advisory_lock\b/,
  /\bpg_advisory_unlock\b/,
  /\bpg_advisory_unlock_all\b/
];

async function walkTsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'migrations') continue;
      files.push(...(await walkTsFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

test('ATP advisory lock SQL is centralized in atpLocks helper', async () => {
  const files = await walkTsFiles(SRC_ROOT);
  const violations = [];
  for (const filePath of files) {
    if (ALLOWED_FILES.has(filePath)) continue;
    const source = await fs.readFile(filePath, 'utf8');
    if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(source))) {
      violations.push(path.relative(process.cwd(), filePath));
    }
  }

  assert.equal(
    violations.length,
    0,
    [
      'ATP_NO_DIRECT_ADVISORY_LOCK_GUARD_FAILED',
      'Use src/domains/inventory/internal/atpLocks.ts as the lock entrypoint.',
      ...violations
    ].join('\n')
  );
});
