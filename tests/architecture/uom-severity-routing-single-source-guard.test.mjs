import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

const ROOT = process.cwd();
const SCAN_ROOTS = [
  path.resolve(ROOT, 'src/services'),
  path.resolve(ROOT, 'src/routes'),
  path.resolve(ROOT, 'src/types')
];

const ALLOWLIST = new Set([
  path.resolve(ROOT, 'src/services/uomSeverityRouting.service.ts'),
  path.resolve(ROOT, 'src/types/uomNormalization.ts')
]);

const REQUIRED_ROUTING_CALLS = [
  {
    file: path.resolve(ROOT, 'src/services/uomConvert.service.ts'),
    pattern: /mapUomStatusToRouting/
  },
  {
    file: path.resolve(ROOT, 'src/services/inventorySnapshot.service.ts'),
    pattern: /mapUomStatusToRouting|resolveTraceOutcome/
  },
  {
    file: path.resolve(ROOT, 'src/services/dashboardKpi.service.ts'),
    pattern: /mapUomStatusToRouting/
  }
];

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

function hasDisallowedSwitchRouting(source) {
  const matches = source.matchAll(/switch\s*\(\s*status\s*\)\s*\{[\s\S]{0,1200}?\}/g);
  for (const match of matches) {
    if (/(?:severity|canAggregate)\s*[:=]/.test(match[0])) {
      return true;
    }
  }
  return false;
}

function hasDisallowedStatusComparisonRouting(source) {
  const patterns = [
    /status\s*===\s*['"][A-Z_]+['"][\s\S]{0,180}?(?:severity|canAggregate)\s*[:=]/,
    /(?:severity|canAggregate)\s*[:=][\s\S]{0,180}?status\s*===\s*['"][A-Z_]+['"]/,
  ];
  return patterns.some((pattern) => pattern.test(source));
}

test('uom status routing must be centralized in uomSeverityRouting service', async () => {
  const files = (
    await Promise.all(SCAN_ROOTS.map((scanRoot) => listTsFiles(scanRoot)))
  ).flat();

  const violations = [];
  for (const filePath of files) {
    if (ALLOWLIST.has(filePath)) continue;

    const source = await readFile(filePath, 'utf8');
    const hasSwitchViolation = hasDisallowedSwitchRouting(source);
    const hasComparisonViolation = hasDisallowedStatusComparisonRouting(source);

    if (hasSwitchViolation || hasComparisonViolation) {
      violations.push(path.relative(ROOT, filePath));
    }
  }

  assert.deepEqual(violations, []);
});

test('uom normalization surface uses uomSeverityRouting helpers in critical paths', async () => {
  for (const required of REQUIRED_ROUTING_CALLS) {
    const source = await readFile(required.file, 'utf8');
    assert.match(source, required.pattern, `missing severity routing usage in ${path.relative(ROOT, required.file)}`);
  }
});
