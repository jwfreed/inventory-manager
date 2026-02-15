import assert from 'node:assert/strict';

let captured = [];
let expected = [];

function normalizePattern(pattern) {
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern === 'string') return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  throw new Error('Invariant log pattern must be string or RegExp');
}

export function resetInvariantLogs() {
  captured = [];
  expected = [];
}

export function expectInvariantLog(pattern) {
  expected.push(normalizePattern(pattern));
}

export function recordInvariantLog(level, args) {
  const message = String(args?.[0] ?? '');
  if (!/(CRITICAL invariant|Invariant (warning|mismatch|violation)|Legacy movement sources)/.test(message)) return;
  captured.push({ level, message, args });
}

export function assertInvariantLogsSatisfied() {
  if (captured.length === 0 && expected.length === 0) return;

  const matched = new Array(captured.length).fill(false);
  const expectedMatched = new Array(expected.length).fill(false);

  captured.forEach((entry, idx) => {
    for (let i = 0; i < expected.length; i += 1) {
      if (expected[i].test(entry.message)) {
        matched[idx] = true;
        expectedMatched[i] = true;
        break;
      }
    }
  });

  const unexpected = captured.filter((_, idx) => !matched[idx]);
  const missing = expected.filter((_, idx) => !expectedMatched[idx]);

  if (unexpected.length > 0 || missing.length > 0) {
    const unexpectedMsgs = unexpected.map((e) => `${e.level}: ${e.message}`);
    const missingMsgs = missing.map((p) => p.toString());
    assert.fail(
      `Invariant log mismatch. unexpected=[${unexpectedMsgs.join('; ')}] missing=[${missingMsgs.join(
        '; '
      )}]`
    );
  }
}
