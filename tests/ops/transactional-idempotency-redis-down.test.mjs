import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const REDIS_DOWN_TIMEOUT_MS = Number(process.env.IDEMPOTENCY_REDIS_DOWN_TIMEOUT_MS ?? '120000');

function tailOutput(text, lines = 120) {
  return String(text ?? '')
    .split(/\r?\n/)
    .slice(-lines)
    .join('\n')
    .trim();
}

test(
  'transactional idempotency remains correct when Redis is unavailable',
  { timeout: REDIS_DOWN_TIMEOUT_MS + 30000 },
  async () => {
    const port = 3900 + (process.pid % 500);
    const args = [
      '--test',
      '--test-reporter=spec',
      '--test-name-pattern',
      'duplicate replay returns same receipt',
      'tests/ops/transactional-idempotency-receipts.test.mjs'
    ];
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith('NODE_TEST')) {
        delete childEnv[key];
      }
    }
    childEnv.API_BASE_URL = `http://127.0.0.1:${port}`;
    childEnv.TEST_BASE_URL = childEnv.API_BASE_URL;
    childEnv.REDIS_URL = 'redis://127.0.0.1:1';

    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: process.cwd(),
        env: childEnv,
        shell: false
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killHandle;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killHandle = setTimeout(() => child.kill('SIGKILL'), 5000);
      }, REDIS_DOWN_TIMEOUT_MS);

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('close', (code, signal) => {
        clearTimeout(timeoutHandle);
        clearTimeout(killHandle);
        resolve({ code, signal, timedOut, stdout, stderr });
      });
    });

    assert.equal(
      result.timedOut,
      false,
      [
        `Redis-down idempotency subprocess timed out after ${REDIS_DOWN_TIMEOUT_MS}ms`,
        '[stdout tail]',
        tailOutput(result.stdout),
        '[stderr tail]',
        tailOutput(result.stderr)
      ].join('\n')
    );
    assert.equal(
      result.code,
      0,
      [
        `Redis-down idempotency subprocess exited with code=${result.code} signal=${result.signal ?? 'none'}`,
        '[stdout tail]',
        tailOutput(result.stdout),
        '[stderr tail]',
        tailOutput(result.stderr)
      ].join('\n')
    );
    assert.match(
      result.stdout,
      /duplicate replay returns same receipt/,
      [
        'Expected duplicate replay receipt test to run successfully with REDIS_URL unreachable.',
        '[stdout tail]',
        tailOutput(result.stdout),
        '[stderr tail]',
        tailOutput(result.stderr)
      ].join('\n')
    );
  }
);
