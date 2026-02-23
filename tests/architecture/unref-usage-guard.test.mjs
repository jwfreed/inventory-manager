import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

const SRC_ROOT = path.resolve(process.cwd(), 'src');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const ALLOWED_UNREF_FILES = new Set([
  'src/lib/cache.ts'
]);
const UNREF_PATTERN = /\.unref\s*\(/g;

async function walkSourceFiles(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkSourceFiles(fullPath)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    files.push(fullPath);
  }
  return files;
}

function getLineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function getLineText(source, lineNumber) {
  return String(source.split('\n')[lineNumber - 1] ?? '').trim();
}

test('src unref usage stays constrained to documented safe files', async () => {
  const files = await walkSourceFiles(SRC_ROOT);
  const occurrences = [];

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    UNREF_PATTERN.lastIndex = 0;
    let match;
    while ((match = UNREF_PATTERN.exec(source)) !== null) {
      const lineNumber = getLineNumber(source, match.index);
      occurrences.push({
        filePath: path.relative(process.cwd(), filePath),
        lineNumber,
        lineText: getLineText(source, lineNumber)
      });
    }
  }

  const unauthorized = occurrences.filter((row) => !ALLOWED_UNREF_FILES.has(row.filePath));
  assert.equal(
    unauthorized.length,
    0,
    [
      'UNREF_USAGE_GUARD_FAILED: .unref() is only allowed in explicitly safe maintenance paths.',
      'If new usage is truly safe, document why and update this allowlist intentionally.',
      ...unauthorized.map((row) => `${row.filePath}:${row.lineNumber} line="${row.lineText}"`)
    ].join('\n')
  );

  const allowlistHits = occurrences.filter((row) => ALLOWED_UNREF_FILES.has(row.filePath));
  assert.ok(
    allowlistHits.length > 0,
    'Expected at least one documented .unref() usage in allowlisted safe files.'
  );
});
