import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { uomSchema } = require('../../src/schemas/shared/uom.schema.ts');

const ROOT_DIR = process.cwd();
const SCHEMA_DIR = path.resolve(ROOT_DIR, 'src/schemas');
const ROUTES_DIR = path.resolve(ROOT_DIR, 'src/routes');
const SHARED_SCHEMA_PATH = path.resolve(ROOT_DIR, 'src/schemas/shared/uom.schema.ts');

async function listTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const resolved = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTsFiles(resolved));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(resolved);
    }
  }
  return files;
}

test('uomSchema trims valid values', () => {
  assert.equal(uomSchema.parse('  EA  '), 'EA');
});

test('uomSchema rejects blank values with UOM_REQUIRED', () => {
  const parsed = uomSchema.safeParse('   ');
  assert.equal(parsed.success, false);
  assert.ok(parsed.error.issues.some((issue) => issue.message === 'UOM_REQUIRED'));
});

test('schema and route UOM fields do not use raw z.string validators', async () => {
  const files = [
    ...(await listTsFiles(SCHEMA_DIR)),
    ...(await listTsFiles(ROUTES_DIR)),
  ].filter((filePath) => filePath !== SHARED_SCHEMA_PATH);

  const violations = [];
  const pattern = /\b(?:uom|[A-Za-z]+Uom)\s*:\s*z\.string\b/g;
  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const line = source.slice(0, match.index).split('\n').length;
      violations.push(`${path.relative(ROOT_DIR, filePath)}:${line}`);
    }
  }

  assert.deepEqual(violations, []);
});
