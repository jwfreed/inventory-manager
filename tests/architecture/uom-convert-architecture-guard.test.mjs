import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SERVICE_PATH = path.resolve(process.cwd(), 'src/services/uomConvert.service.ts');
const SERVICES_DIR = path.resolve(process.cwd(), 'src/services');

test('uom conversion service must use decimal.js and block cross-dimension fallback', async () => {
  const source = await readFile(SERVICE_PATH, 'utf8');

  assert.match(source, /from 'decimal\.js'/);
  assert.match(source, /UOM_DIMENSION_MISMATCH/);
  assert.match(
    source,
    /if\s*\(registryError\.code === 'UOM_DIMENSION_MISMATCH'\)\s*\{\s*throw registryError;\s*\}/
  );

  const forbiddenFloatingMath = [
    /qty\s*\*\s*.*toBaseFactor/,
    /qtyBase\s*\/\s*.*toBaseFactor/,
  ];
  for (const pattern of forbiddenFloatingMath) {
    assert.equal(
      pattern.test(source),
      false,
      `FORBIDDEN_FLOATING_UOM_MATH: ${pattern}`
    );
  }
});

async function listTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const resolved = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(resolved)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(resolved);
    }
  }
  return files;
}

test('legacy conversion table access is restricted to converter adapter and CRUD service', async () => {
  const files = await listTsFiles(SERVICES_DIR);
  const allowed = new Set([
    path.resolve(process.cwd(), 'src/services/uomConvert.service.ts'),
    path.resolve(process.cwd(), 'src/services/masterData.service.ts')
  ]);

  const violations = [];
  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    if (!source.includes('uom_conversions')) continue;
    if (!allowed.has(filePath)) {
      violations.push(path.relative(process.cwd(), filePath));
    }
  }

  assert.deepEqual(violations, []);
});
