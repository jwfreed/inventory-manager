import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const ALLOWED = new Set([
  path.join(SRC, 'domain', 'receipts', 'receiptAllocationModel.ts')
]);

const WRITE_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: 'receipt_allocations',
    regex: /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+receipt_allocations\b/i
  }
];

const LOW_LEVEL_ALLOWED = new Set([
  path.join(SRC, 'domain', 'receipts', 'receiptAllocationModel.ts'),
  path.join(SRC, 'domain', 'receipts', 'receiptAllocationRebuilder.ts')
]);

const LOW_LEVEL_SYMBOLS = [
  'createInitialReceiptAllocationWriteContext',
  'createRebuildReceiptAllocationWriteContext',
  'insertReceiptAllocations',
  'consumeReceiptAllocations',
  'replaceReceiptAllocationsForReceipt'
];

const BACKGROUND_REBUILD_SYMBOLS = [
  'rebuildReceiptAllocations',
  'validateOrRebuildReceiptAllocationsForMutation'
];

const violations: Array<{ file: string; pattern: string }> = [];

function walk(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      if (entry.name === 'migrations') continue;
      walk(full);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (ALLOWED.has(full)) continue;
    const contents = fs.readFileSync(full, 'utf8');
    for (const pattern of WRITE_PATTERNS) {
      if (pattern.regex.test(contents)) {
        violations.push({ file: full, pattern: pattern.name });
      }
    }
    if (!LOW_LEVEL_ALLOWED.has(full)) {
      for (const symbol of LOW_LEVEL_SYMBOLS) {
        if (new RegExp(`\\b${symbol}\\b`).test(contents)) {
          violations.push({ file: full, pattern: `low-level ${symbol}` });
        }
      }
    }
  }
}

walk(SRC);

for (const rel of ['src/jobs', 'src/worker.ts', 'src/server.ts']) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const files = fs.statSync(full).isDirectory() ? [] : [full];
  if (fs.statSync(full).isDirectory()) {
    const collect = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(child);
        else if (entry.name.endsWith('.ts')) files.push(child);
      }
    };
    collect(full);
  }
  for (const file of files) {
    const contents = fs.readFileSync(file, 'utf8');
    for (const symbol of BACKGROUND_REBUILD_SYMBOLS) {
      if (new RegExp(`\\b${symbol}\\b`).test(contents)) {
        violations.push({ file, pattern: `background ${symbol}` });
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Receipt allocation write ownership violations detected:');
  for (const v of violations) {
    console.error(`- ${path.relative(ROOT, v.file)} uses ${v.pattern} write`);
  }
  process.exit(1);
}

console.log('Receipt allocation write ownership check passed.');
