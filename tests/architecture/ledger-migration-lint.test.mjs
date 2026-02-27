import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const MIGRATIONS_ROOT = path.resolve(process.cwd(), 'src/migrations');
const PRAGMA_LINE = '-- ledger-immutability:allow-dangerous-migration';

const DANGEROUS_PATTERNS = [
  {
    id: 'drop-trigger-ledger-table',
    description: 'DROP TRIGGER on ledger table',
    regex: /drop\s+trigger\b[^;\n]*\bon\s+(?:public\.)?(inventory_movements|inventory_movement_lines)\b/i
  },
  {
    id: 'alter-disable-ledger-trigger',
    description: 'ALTER TABLE ledger table DISABLE TRIGGER',
    regex: /alter\s+table\s+(?:public\.)?(inventory_movements|inventory_movement_lines)\b[^;\n]*\bdisable\s+trigger\b/i
  },
  {
    id: 'alter-enable-ledger-trigger',
    description: 'ALTER TABLE ledger table ENABLE TRIGGER',
    regex: /alter\s+table\s+(?:public\.)?(inventory_movements|inventory_movement_lines)\b[^;\n]*\benable\s+trigger\b/i
  },
  {
    id: 'drop-prevent-ledger-mutation-function',
    description: 'DROP FUNCTION prevent_ledger_mutation',
    regex: /drop\s+function\b[^;\n]*\bprevent_ledger_mutation\b/i
  },
  {
    id: 'truncate-ledger-table',
    description: 'TRUNCATE ledger table',
    regex: /truncate\b[^;\n]*\b(inventory_movements|inventory_movement_lines)\b/i
  },
  {
    id: 'alter-owner-ledger-table',
    description: 'ALTER TABLE ledger table OWNER TO',
    regex: /alter\s+table\s+(?:public\.)?(inventory_movements|inventory_movement_lines)\b[^;\n]*\bowner\s+to\b/i
  },
  {
    id: 'near-miss-drop-trigger',
    description: 'Near-miss DROP TRIGGER .*inventory_movement',
    regex: /drop\s+trigger\b[^;\n]*inventory_movement/i
  },
  {
    id: 'near-miss-disable-trigger',
    description: 'Near-miss DISABLE TRIGGER .*inventory_movement',
    regex: /disable\s+trigger\b[^;\n]*inventory_movement/i
  },
  {
    id: 'near-miss-truncate',
    description: 'Near-miss TRUNCATE .*inventory_movement',
    regex: /truncate\b[^;\n]*inventory_movement/i
  }
];

async function listFilesRecursive(rootPath) {
  const result = [];
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listFilesRecursive(fullPath)));
      continue;
    }
    if (!entry.isFile()) continue;
    result.push(fullPath);
  }
  return result;
}

function validatePragma(lines, filePath) {
  const pragmaIndex = lines.findIndex((line) => line.trim() === PRAGMA_LINE);
  if (pragmaIndex === -1) return { bypass: false, error: null };

  const reasonLine = lines[pragmaIndex + 1] ?? '';
  if (!reasonLine.trim().toLowerCase().startsWith('-- reason:')) {
    return {
      bypass: false,
      error: `${filePath}: pragma present without required next-line explanation (-- reason: ...)`
    };
  }

  return { bypass: true, error: null };
}

function collectViolations(content, filePath) {
  const lines = content.split(/\r?\n/);
  const violations = [];

  for (const pattern of DANGEROUS_PATTERNS) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!pattern.regex.test(line)) continue;
      violations.push({
        filePath,
        lineNumber: index + 1,
        patternId: pattern.id,
        description: pattern.description,
        snippet: line.trim()
      });
    }
  }

  return violations;
}

test('migrations do not contain dangerous ledger immutability statements unless pragma+reason override is present', async () => {
  const allFiles = await listFilesRecursive(MIGRATIONS_ROOT);
  const migrationFiles = allFiles.filter((filePath) => /\.(ts|js|mjs|sql)$/i.test(filePath));

  const pragmaErrors = [];
  const violations = [];

  for (const filePath of migrationFiles) {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const pragma = validatePragma(lines, filePath);
    if (pragma.error) {
      pragmaErrors.push(pragma.error);
      continue;
    }
    if (pragma.bypass) {
      continue;
    }

    violations.push(...collectViolations(content, filePath));
  }

  if (pragmaErrors.length > 0 || violations.length > 0) {
    const errorLines = [];

    for (const message of pragmaErrors) {
      errorLines.push(`- ${path.relative(process.cwd(), message)}`);
    }

    for (const violation of violations) {
      errorLines.push(
        `- ${path.relative(process.cwd(), violation.filePath)}:${violation.lineNumber} [${violation.patternId}] ${violation.description} :: ${violation.snippet}`
      );
    }

    assert.fail(
      [
        'LEDGER_MIGRATION_LINT_FAILED: dangerous ledger immutability migration statements were found.',
        'Add explicit override only when intentional using:',
        '-- ledger-immutability:allow-dangerous-migration',
        '-- reason: <why this dangerous migration is required>',
        ...errorLines
      ].join('\n')
    );
  }
});
