import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const ALLOWED = new Set([
  path.join(SRC, 'domains', 'inventory', 'internal', 'ledgerWriter.ts'),
  path.join(SRC, 'domains', 'inventory', 'internal', 'inventoryBalance.ts')
]);

const WRITE_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'inventory_movements', regex: /\b(INSERT|UPDATE|DELETE)\s+.*\binventory_movements\b/i },
  { name: 'inventory_movement_lines', regex: /\b(INSERT|UPDATE|DELETE)\s+.*\binventory_movement_lines\b/i },
  { name: 'inventory_balance', regex: /\b(INSERT|UPDATE|DELETE)\s+.*\binventory_balance\b/i }
];

const violations: Array<{ file: string; pattern: string }> = [];

function walk(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
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
  }
}

walk(SRC);

if (violations.length > 0) {
  console.error('Inventory write ownership violations detected:');
  for (const v of violations) {
    console.error(`- ${path.relative(ROOT, v.file)} uses ${v.pattern} write`);
  }
  process.exit(1);
}

console.log('Inventory write ownership check passed.');
