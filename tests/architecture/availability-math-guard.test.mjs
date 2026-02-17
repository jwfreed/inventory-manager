import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SERVICES_DIR = path.resolve(process.cwd(), 'src/services');
const ALLOWED_FILES = [];

const FORBIDDEN_PATTERNS = [
  {
    name: 'onHand-minus-reserved',
    regex: /\bonHand\s*-\s*[^\n;]*\breserved\b/
  },
  {
    name: 'on_hand-minus-reserved',
    regex: /\bon_hand\s*-\s*[^\n;]*\breserved\b/
  },
  {
    name: 'available-assignment-from-onHand',
    regex: /\bavailable\w*\s*=\s*[^\n;]*\bonHand\b/
  },
  {
    name: 'available-assignment-from-on_hand',
    regex: /\bavailable\w*\s*=\s*[^\n;]*\bon_hand\b/
  },
  {
    name: 'on_hand_qty-minus-reserved_qty',
    regex: /\bon_hand_qty\s*-\s*[^\n;]*\breserved_qty\b/
  }
];

function blankPreservingNewlines(segment) {
  return segment.replace(/[^\r\n]/g, ' ');
}

function stripCommentsPreservingStrings(source) {
  let out = '';
  let index = 0;
  let state = 'code';

  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];

    if (state === 'line_comment') {
      if (ch === '\n' || ch === '\r') {
        state = 'code';
        out += ch;
      } else {
        out += ' ';
      }
      index += 1;
      continue;
    }

    if (state === 'block_comment') {
      if (ch === '*' && next === '/') {
        out += '  ';
        index += 2;
        state = 'code';
        continue;
      }
      out += ch === '\n' || ch === '\r' ? ch : ' ';
      index += 1;
      continue;
    }

    if (state === 'single_quote') {
      out += ch;
      if (ch === '\\' && index + 1 < source.length) {
        out += source[index + 1];
        index += 2;
        continue;
      }
      if (ch === "'") state = 'code';
      index += 1;
      continue;
    }

    if (state === 'double_quote') {
      out += ch;
      if (ch === '\\' && index + 1 < source.length) {
        out += source[index + 1];
        index += 2;
        continue;
      }
      if (ch === '"') state = 'code';
      index += 1;
      continue;
    }

    if (state === 'template') {
      out += ch;
      if (ch === '\\' && index + 1 < source.length) {
        out += source[index + 1];
        index += 2;
        continue;
      }
      if (ch === '`') state = 'code';
      index += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      out += '  ';
      index += 2;
      state = 'line_comment';
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      index += 2;
      state = 'block_comment';
      continue;
    }
    if (ch === "'") {
      out += ch;
      index += 1;
      state = 'single_quote';
      continue;
    }
    if (ch === '"') {
      out += ch;
      index += 1;
      state = 'double_quote';
      continue;
    }
    if (ch === '`') {
      out += ch;
      index += 1;
      state = 'template';
      continue;
    }

    out += ch;
    index += 1;
  }

  return out;
}

function stripStringLiterals(source) {
  return source
    .replace(/'(?:\\.|[^'\\\r\n])*'/g, blankPreservingNewlines)
    .replace(/"(?:\\.|[^"\\\r\n])*"/g, blankPreservingNewlines)
    .replace(/`(?:\\.|[\s\S])*?`/g, blankPreservingNewlines);
}

async function listServiceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listServiceFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      files.push(fullPath);
    }
  }
  return files;
}

test('service layer must not recompute availability math', async () => {
  const files = await listServiceFiles(SERVICES_DIR);
  const violations = [];

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    const relativePath = path.relative(process.cwd(), filePath);
    if (ALLOWED_FILES.includes(relativePath)) {
      continue;
    }

    // Ignore comments and string literals so only executable service logic is scanned.
    const executableSource = stripStringLiterals(stripCommentsPreservingStrings(source));
    const lines = executableSource.split(/\r?\n/);

    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (!pattern.regex.test(line)) continue;
        violations.push({
          filePath: relativePath,
          line: idx + 1,
          pattern: pattern.name,
          text: line.trim()
        });
      }
    }
  }

  assert.equal(
    violations.length,
    0,
    [
      'AVAILABILITY_MATH_RECOMPUTE_FORBIDDEN: Use canonical inventory_available_* views instead.',
      ...violations.map(
        (v) => `${v.filePath}:${v.line} [${v.pattern}] ${v.text}`
      )
    ].join('\n')
  );
});
