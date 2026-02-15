import { afterEach, after, beforeEach } from 'node:test';
import { clearWaitForTimers } from './api/helpers/waitFor.mjs';
import { snapshotActiveHandles, diffHandleSnapshots } from './api/helpers/activeHandles.mjs';
import { closeDbPool } from './helpers/dbPool.mjs';
import {
  resetInvariantLogs,
  recordInvariantLog,
  assertInvariantLogsSatisfied
} from './helpers/invariantLogs.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const delayMs = Number(process.env.TEST_AFTER_EACH_DELAY_MS ?? '100');
const debugHandles = process.env.TEST_DEBUG_HANDLES === '1';

// NOTE:
// TEST_DEBUG_HANDLES=1 can be used to diagnose event-loop leaks.
// Full sequential run verified clean as of 2026-02-09.

let handleSnapshot;
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
const originalInfo = console.info.bind(console);

console.warn = (...args) => {
  recordInvariantLog('warn', args);
  originalWarn(...args);
};

console.error = (...args) => {
  recordInvariantLog('error', args);
  originalError(...args);
};

console.info = (...args) => {
  recordInvariantLog('info', args);
  originalInfo(...args);
};

if (debugHandles) {
  // Usage:
  // TEST_DEBUG_HANDLES=1 node --test --test-reporter=spec --test-timeout=120000 --test-concurrency=1 --import ./tests/setup.mjs tests/api/*.test.mjs tests/ops/*.test.mjs tests/db/*.test.mjs
  beforeEach(() => {
    handleSnapshot = snapshotActiveHandles();
    resetInvariantLogs();
  });
} else {
  beforeEach(() => {
    resetInvariantLogs();
  });
}

if (delayMs > 0) {
  afterEach(async () => {
    if (debugHandles) {
      const afterSnapshot = snapshotActiveHandles();
      const diff = diffHandleSnapshots(handleSnapshot, afterSnapshot);
      if (diff.added.length > 0) {
        console.error(`[handles] afterEach new handles:`, diff.addedCounts);
      }
    }
    clearWaitForTimers();
    assertInvariantLogsSatisfied();
    await sleep(delayMs);
  });
} else {
  afterEach(() => {
    if (debugHandles) {
      const afterSnapshot = snapshotActiveHandles();
      const diff = diffHandleSnapshots(handleSnapshot, afterSnapshot);
      if (diff.added.length > 0) {
        console.error(`[handles] afterEach new handles:`, diff.addedCounts);
      }
    }
    clearWaitForTimers();
    assertInvariantLogsSatisfied();
  });
}

after(async () => {
  if (debugHandles) {
    const finalSnapshot = snapshotActiveHandles();
    console.error(`[handles] final active handles:`, finalSnapshot.handles);
    if (finalSnapshot.requests.length > 0) {
      console.error(`[handles] final active requests:`, finalSnapshot.requests);
    }
  }
  await closeDbPool();
});
