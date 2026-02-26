import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

const ROUTES_ROOT = path.resolve(process.cwd(), 'src/routes');
const SERVICES_ROOT = path.resolve(process.cwd(), 'src/services');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const FORBIDDEN_ROUTE_SEGMENTS = ['line-side', 'issue-to-line', 'return-from-line'];
const FORBIDDEN_SERVICE_CAPABILITY_TOKENS = ['issueToLine', 'returnFromLine', 'lineSide'];

async function walkFiles(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
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

test('route and service capability surface excludes line-side workflows', async () => {
  const violations = [];

  for (const filePath of await walkFiles(ROUTES_ROOT)) {
    const source = await readFile(filePath, 'utf8');
    const routeDefinitionPattern = /router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = routeDefinitionPattern.exec(source)) !== null) {
      const routePath = String(match[2] ?? '');
      if (!FORBIDDEN_ROUTE_SEGMENTS.some((segment) => routePath.toLowerCase().includes(segment))) continue;
      const lineNumber = getLineNumber(source, match.index);
      violations.push({
        filePath: path.relative(process.cwd(), filePath),
        lineNumber,
        type: 'route',
        value: routePath,
        lineText: getLineText(source, lineNumber)
      });
    }
  }

  for (const filePath of await walkFiles(SERVICES_ROOT)) {
    const source = await readFile(filePath, 'utf8');
    for (const token of FORBIDDEN_SERVICE_CAPABILITY_TOKENS) {
      const pattern = new RegExp(`\\b${token}\\b`, 'g');
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const lineNumber = getLineNumber(source, match.index);
        violations.push({
          filePath: path.relative(process.cwd(), filePath),
          lineNumber,
          type: 'service-token',
          value: token,
          lineText: getLineText(source, lineNumber)
        });
      }
    }
  }

  assert.equal(
    violations.length,
    0,
    [
      'NO_LINE_SIDE_CAPABILITY_GUARD_FAILED: line-side/staging workflows must remain absent until explicitly designed.',
      ...violations.map((violation) =>
        `${violation.filePath}:${violation.lineNumber} [${violation.type}] value="${violation.value}" line="${violation.lineText}"`
      )
    ].join('\n')
  );
});
