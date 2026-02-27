import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const MIGRATIONS_ROOT = path.resolve(process.cwd(), 'src/migrations');
const PRAGMA_LINE = '-- ledger-immutability:allow-dangerous-migration';
const PRAGMA_TICKET_PATTERN = /(?:\b[A-Z]{2,}-\d+\b|#\d+\b)/;

const DANGEROUS_PATTERNS = [
  {
    id: 'drop-trigger-ledger-table',
    description: 'DROP immutability trigger on ledger table',
    regex:
      /drop\s+trigger\b[^;\n]*\b(?:inventory_movement_lines_no_(?:update|delete)|inventory_movements_no_(?:update|delete)|trg_[^;\n]*immutable|[^;\n]*ledger[^;\n]*)\b[^;\n]*\bon\s+(?:public\.)?(inventory_movements|inventory_movement_lines)\b/i
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
  if (!PRAGMA_TICKET_PATTERN.test(reasonLine)) {
    return {
      bypass: false,
      error: `${filePath}: pragma reason must include a ticket/reference token (for example INV-123 or #123)`
    };
  }

  return { bypass: true, error: null, reasonLine };
}

function getMigrationSections(content) {
  const upMatch = /export\s+async\s+function\s+up\s*\(/i.exec(content);
  const downMatch = /export\s+async\s+function\s+down\s*\(/i.exec(content);
  return {
    upStart: upMatch?.index ?? -1,
    downStart: downMatch?.index ?? -1
  };
}

function sectionForIndex(index, sections) {
  const { upStart, downStart } = sections;
  if (index < 0) return 'unknown';
  if (upStart === -1 && downStart === -1) return 'unknown';
  if (upStart !== -1 && (downStart === -1 || upStart < downStart)) {
    if (index < upStart) return 'preamble';
    if (downStart !== -1 && index >= downStart) return 'down';
    return 'up';
  }
  if (downStart !== -1 && (upStart === -1 || downStart < upStart)) {
    if (index < downStart) return 'preamble';
    if (upStart !== -1 && index >= upStart) return 'up';
    return 'down';
  }
  return 'unknown';
}

function collectViolations(content, filePath) {
  const sections = getMigrationSections(content);
  const violations = [];

  for (const pattern of DANGEROUS_PATTERNS) {
    const flags = pattern.regex.flags.includes('g') ? pattern.regex.flags : `${pattern.regex.flags}g`;
    const globalRegex = new RegExp(pattern.regex.source, flags);
    let match;
    while ((match = globalRegex.exec(content)) !== null) {
      const charIndex = match.index;
      const lineNumber = content.slice(0, charIndex).split(/\r?\n/).length;
      const line = content.split(/\r?\n/)[lineNumber - 1] ?? '';
      violations.push({
        filePath,
        lineNumber,
        section: sectionForIndex(charIndex, sections),
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
    const fileViolations = collectViolations(content, filePath);
    if (pragma.bypass) {
      if (fileViolations.length === 0) {
        pragmaErrors.push(
          `${filePath}: pragma present without matching dangerous ledger statement; remove blanket pragma`
        );
      }
      const blockedSections = fileViolations.filter((violation) => violation.section !== 'down');
      if (blockedSections.length > 0) {
        for (const blocked of blockedSections) {
          pragmaErrors.push(
            `${filePath}:${blocked.lineNumber} pragma cannot suppress dangerous pattern in ${blocked.section}() [${blocked.patternId}]`
          );
        }
      }
      continue;
    }

    violations.push(...fileViolations);
  }

  if (pragmaErrors.length > 0 || violations.length > 0) {
    const errorLines = [];

    for (const message of pragmaErrors) {
      errorLines.push(`- ${message}`);
    }

    for (const violation of violations) {
      errorLines.push(
        `- ${path.relative(process.cwd(), violation.filePath)}:${violation.lineNumber} [${violation.patternId}] section=${violation.section} ${violation.description} :: ${violation.snippet}`
      );
    }

    assert.fail(
      [
        'LEDGER_MIGRATION_LINT_FAILED: dangerous ledger immutability migration statements were found.',
        'Add explicit override only when intentional using:',
        '-- ledger-immutability:allow-dangerous-migration',
        '-- reason: <why this dangerous migration is required> <ticket e.g. INV-123 or #123>',
        ...errorLines
      ].join('\n')
    );
  }
});
