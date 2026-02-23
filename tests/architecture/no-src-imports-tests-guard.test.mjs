import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

const SRC_ROOT = path.resolve(process.cwd(), 'src');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const IMPORT_PATTERNS = [
  /\bimport(?:\s+type)?[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bexport[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
];

function normalizeSpecifier(specifier) {
  return String(specifier ?? '').replace(/\\/g, '/').trim();
}

function isForbiddenTestsSpecifier(specifier) {
  const normalized = normalizeSpecifier(specifier);
  if (!normalized) return false;
  if (normalized.startsWith('tests/')) return true;
  if (normalized.includes('/tests/')) return true;
  if (/^[@~]\/tests(?:\/|$)/.test(normalized)) return true;
  return false;
}

function getLineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function getLineText(source, lineNumber) {
  return String(source.split('\n')[lineNumber - 1] ?? '').trim();
}

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

function collectForbiddenImports(source) {
  const matches = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = normalizeSpecifier(match[1]);
      if (!isForbiddenTestsSpecifier(specifier)) continue;
      const lineNumber = getLineNumber(source, match.index);
      matches.push({
        specifier,
        lineNumber,
        lineText: getLineText(source, lineNumber)
      });
    }
  }
  return matches;
}

test('src modules must not import tests/ paths or test aliases', async () => {
  const sourceFiles = await walkSourceFiles(SRC_ROOT);
  const violations = [];

  for (const filePath of sourceFiles) {
    const source = await readFile(filePath, 'utf8');
    const forbiddenImports = collectForbiddenImports(source);
    for (const violation of forbiddenImports) {
      violations.push({
        filePath: path.relative(process.cwd(), filePath),
        ...violation
      });
    }
  }

  assert.equal(
    violations.length,
    0,
    [
      'SRC_IMPORTS_TESTS_GUARD_FAILED: files under src/ must not import tests/ modules or test aliases.',
      'Move shared logic to src/ or scripts/ and keep test-only helpers under tests/.',
      ...violations.map((violation) =>
        `${violation.filePath}:${violation.lineNumber} specifier="${violation.specifier}" line="${violation.lineText}"`
      )
    ].join('\n')
  );
});
