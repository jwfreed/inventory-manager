import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'migrations') continue;
      walk(full, acc);
      continue;
    }
    if (entry.name.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('receipt allocation writes are owned by the allocation domain model', () => {
  const allowed = new Set([
    path.join(ROOT, 'src/domain/receipts/receiptAllocationModel.ts')
  ]);
  const violations = walk(path.join(ROOT, 'src'))
    .filter((file) => !allowed.has(file))
    .filter((file) => /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+receipt_allocations\b/i.test(read(file)))
    .map((file) => path.relative(ROOT, file));

  assert.deepEqual(violations, []);
});

test('receipt allocations are not an inventory ledger or projection authority', () => {
  const forbiddenRoots = [
    'src/domains/inventory',
    'src/modules/platform/application'
  ];
  const violations = forbiddenRoots.flatMap((root) =>
    walk(path.join(ROOT, root))
      .filter((file) => read(file).includes('receipt_allocations'))
      .map((file) => path.relative(ROOT, file))
  );

  assert.deepEqual(violations, []);
});

test('background code cannot rebuild receipt allocations', () => {
  const checkedRoots = [
    'src/jobs',
    'src/worker.ts',
    'src/server.ts'
  ];
  const files = checkedRoots.flatMap((root) => {
    const full = path.join(ROOT, root);
    if (!fs.existsSync(full)) return [];
    return fs.statSync(full).isDirectory() ? walk(full) : [full];
  });
  const violations = files
    .filter((file) => read(file).includes('rebuildReceiptAllocations'))
    .map((file) => path.relative(ROOT, file));

  assert.deepEqual(violations, []);
});
