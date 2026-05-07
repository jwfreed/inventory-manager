#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_SCAN_ROOTS = ['src', 'scripts'];
const CUSTOM_SCAN_ROOTS = String(process.env.POWER10_SCAN_ROOTS ?? '').trim();
const SCAN_ROOTS = parseScanRoots();
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);
const SKIP_FILES = new Set([path.join(ROOT, 'scripts', 'check-power10-guards.mjs')]);

const INVENTORY_WRITE_ALLOWED = new Set([
  'src/domains/inventory/internal/ledgerWriter.ts',
  'src/domains/inventory/internal/inventoryUnits.ts',
  'src/domains/inventory/internal/inventoryBalance.ts',
  'src/modules/availability/infrastructure/inventoryBalance.projector.ts',
  'src/services/inventoryLedgerReconcile.service.ts'
].map((file) => path.join(ROOT, file)));

const LEDGER_TABLES = ['inventory_movements', 'inventory_movement_lines'];
const INVENTORY_SYSTEM_TABLES = [
  ...LEDGER_TABLES,
  'inventory_balance',
  'inventory_units',
  'inventory_unit_events'
];

const violations = [];

function relative(filePath) {
  return path.relative(ROOT, filePath);
}

function parseScanRoots() {
  if (!CUSTOM_SCAN_ROOTS) return DEFAULT_SCAN_ROOTS;
  return CUSTOM_SCAN_ROOTS
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveScanRoot(scanRoot) {
  if (path.isAbsolute(scanRoot)) return scanRoot;
  return path.join(ROOT, scanRoot);
}

function lineNumberForIndex(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function lineAt(source, index) {
  const lineNumber = lineNumberForIndex(source, index);
  return source.split(/\r?\n/)[lineNumber - 1] ?? '';
}

function contextBefore(source, index, lineCount = 3) {
  const lines = source.slice(0, index).split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - lineCount)).join('\n');
}

function contextAfter(source, index, charCount = 2500) {
  return source.slice(index, index + charCount);
}

function hasPower10Annotation(source, index, tag) {
  const before = contextBefore(source, index, 4);
  const current = lineAt(source, index);
  return new RegExp(`power10:\\s*${tag}\\b`, 'i').test(`${before}\n${current}`);
}

function addViolation(filePath, lineNumber, code, message) {
  violations.push({
    filePath,
    lineNumber,
    code,
    message
  });
}

function listFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const stats = fs.statSync(dirPath);
  if (stats.isFile()) {
    if (!SOURCE_EXTENSIONS.has(path.extname(dirPath))) return [];
    if (SKIP_FILES.has(dirPath)) return [];
    return [dirPath];
  }
  const result = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (relative(fullPath) === path.join('src', 'migrations')) continue;
      result.push(...listFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    if (SKIP_FILES.has(fullPath)) continue;
    result.push(fullPath);
  }
  return result;
}

function isKnownBoundedRetry(source, index) {
  const after = contextAfter(source, index);
  return (
    /\battempt\s*<\s*retries\b/.test(after)
    && /\battempt\s*=/.test(after)
    && /\bcontinue\b/.test(after)
    && /\bthrow\b/.test(after)
  );
}

function checkWhileTrue(filePath, source) {
  const pattern = /\bwhile\s*\(\s*true\s*\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (
      hasPower10Annotation(source, match.index, 'bounded-loop')
      || hasPower10Annotation(source, match.index, 'bounded-retry')
      || isKnownBoundedRetry(source, match.index)
    ) {
      continue;
    }
    addViolation(
      filePath,
      lineNumberForIndex(source, match.index),
      'POWER10_UNBOUNDED_LOOP',
      'while (true) requires a nearby power10: bounded-loop annotation or a structurally bounded retry exit.'
    );
  }
}

function checkTsIgnore(filePath, source) {
  const pattern = /@ts-ignore[^\n]*/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const comment = match[0];
    if (/power10:\s*ts-ignore\s*--\s*\S.{15,}/i.test(comment)) continue;
    addViolation(
      filePath,
      lineNumberForIndex(source, match.index),
      'POWER10_TS_IGNORE',
      '@ts-ignore must include a same-line "power10: ts-ignore -- <specific reason>" justification. Prefer @ts-expect-error when possible.'
    );
  }
}

function checkInventoryWrites(filePath, source) {
  const isAllowedWriter = INVENTORY_WRITE_ALLOWED.has(filePath);

  for (const table of LEDGER_TABLES) {
    const updateDelete = new RegExp(`\\b(?:UPDATE|DELETE\\s+FROM)\\s+(?:public\\.)?${table}\\b`, 'ig');
    let match;
    while ((match = updateDelete.exec(source)) !== null) {
      addViolation(
        filePath,
        lineNumberForIndex(source, match.index),
        'POWER10_LEDGER_MUTATION',
        `${table} is append-only; UPDATE/DELETE statements are not allowed outside explicit migration lint overrides.`
      );
    }
  }

  if (isAllowedWriter) return;

  for (const table of INVENTORY_SYSTEM_TABLES) {
    const write = new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:public\\.)?${table}\\b`, 'ig');
    let match;
    while ((match = write.exec(source)) !== null) {
      addViolation(
        filePath,
        lineNumberForIndex(source, match.index),
        'POWER10_DIRECT_INVENTORY_WRITE',
        `${table} writes must stay inside approved inventory writer/projector modules. Use the canonical inventory write boundary or extend the allowlist with a documented reason.`
      );
    }
  }
}

function checkEmptyCatch(filePath, source) {
  const pattern = /(?<!\.)\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)?\s*\}/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (
      hasPower10Annotation(source, match.index, 'intentional-empty-catch')
      || /power10:\s*intentional-empty-catch\b/i.test(match[0])
    ) {
      continue;
    }
    addViolation(
      filePath,
      lineNumberForIndex(source, match.index),
      'POWER10_EMPTY_CATCH',
      'Empty catch blocks must handle, rethrow, or include a nearby "power10: intentional-empty-catch" annotation with a reason.'
    );
  }
}

function checkUnboundedBatchPatterns(filePath, source) {
  if (!CUSTOM_SCAN_ROOTS && !relative(filePath).startsWith('src/')) return;

  const promiseAllRows = /\bPromise\.all\s*\(\s*(?:\w+Rows|rows|result\.rows)\.map\s*\(/g;
  let match;
  while ((match = promiseAllRows.exec(source)) !== null) {
    if (hasPower10Annotation(source, match.index, 'bounded-batch')) continue;
    addViolation(
      filePath,
      lineNumberForIndex(source, match.index),
      'POWER10_UNBOUNDED_BATCH_PROMISES',
      'Promise.all over query rows can grow concurrency without bound; add a limit/concurrency cap or a nearby "power10: bounded-batch" annotation.'
    );
  }

  const selectWithOffset = /SELECT\s+\*[\s\S]{0,500}\bOFFSET\b/gi;
  while ((match = selectWithOffset.exec(source)) !== null) {
    const queryWindow = match[0];
    if (/\bLIMIT\b/i.test(queryWindow)) continue;
    if (hasPower10Annotation(source, match.index, 'bounded-batch')) continue;
    addViolation(
      filePath,
      lineNumberForIndex(source, match.index),
      'POWER10_UNBOUNDED_SELECT_OFFSET',
      'Paginated production SELECT * queries must include LIMIT near OFFSET or a "power10: bounded-batch" annotation.'
    );
  }
}

const files = SCAN_ROOTS.flatMap((root) => listFiles(resolveScanRoot(root)));

for (const filePath of files) {
  const source = fs.readFileSync(filePath, 'utf8');
  checkWhileTrue(filePath, source);
  checkTsIgnore(filePath, source);
  checkInventoryWrites(filePath, source);
  checkEmptyCatch(filePath, source);
  checkUnboundedBatchPatterns(filePath, source);
}

if (violations.length > 0) {
  console.error('Power10 guard violations detected:');
  for (const violation of violations) {
    console.error(
      `- ${relative(violation.filePath)}:${violation.lineNumber} [${violation.code}] ${violation.message}`
    );
  }
  console.error('\nAllowed exception annotations must be local, specific, and reviewed. See docs/engineering/power-of-ten-inventory-standard.md.');
  process.exit(1);
}

console.log(`Power10 guard check passed (${files.length} files scanned).`);
