import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const EXIT_TIMEOUT_MS = Number(process.env.OPS_PROCESS_EXIT_TIMEOUT_MS ?? '60000');
const OUTPUT_TAIL_LINES = Number(process.env.OPS_PROCESS_EXIT_OUTPUT_TAIL_LINES ?? '80');

function tailOutput(text, lineCount = OUTPUT_TAIL_LINES) {
  const lines = String(text ?? '').split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - lineCount)).join('\n').trim();
}

async function runNodeTestFile(args, { timeoutMs }) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith('NODE_TEST')) {
        delete childEnv[key];
      }
    }
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: childEnv,
      shell: false
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutHandle;
    let killHandle;

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killHandle = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5000);
    }, timeoutMs);

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
}

async function assertSubprocessTestExitsCleanly({ filePath, expectedStdoutPattern }) {
  const result = await runNodeTestFile(
    ['--test', '--test-reporter=spec', filePath],
    { timeoutMs: EXIT_TIMEOUT_MS }
  );
  const stdoutTail = tailOutput(result.stdout);
  const stderrTail = tailOutput(result.stderr);

  assert.equal(
    result.timedOut,
    false,
    [
      `Process did not exit within ${EXIT_TIMEOUT_MS}ms for ${filePath}`,
      '[stdout tail]',
      stdoutTail,
      '[stderr tail]',
      stderrTail
    ].filter(Boolean).join('\n')
  );
  assert.equal(
    result.code,
    0,
    [
      `Unexpected exit code=${result.code} signal=${result.signal ?? 'none'} for ${filePath}`,
      '[stdout tail]',
      stdoutTail,
      '[stderr tail]',
      stderrTail
    ].filter(Boolean).join('\n')
  );
  assert.match(
    result.stdout,
    expectedStdoutPattern,
    [
      `Expected representative assertions to run for ${filePath}`,
      '[stdout tail]',
      stdoutTail,
      '[stderr tail]',
      stderrTail
    ].filter(Boolean).join('\n')
  );
}

test(
  'representative ops subprocesses exit cleanly without lingering handles',
  { timeout: (EXIT_TIMEOUT_MS * 2) + 30000 },
  async () => {
    const subprocessSuites = [
      {
        filePath: 'tests/ops/atp-concurrency-hardening.test.mjs',
        expectedStdoutPattern: /ATP retry jitter\/exhaustion mapping stays deterministic and emits metrics/
      },
      {
        filePath: 'tests/ops/strict-invariants-valid-topology.test.mjs',
        expectedStdoutPattern: /strict invariants pass for a test tenant with canonical topology/
      }
    ];

    for (const suite of subprocessSuites) {
      await assertSubprocessTestExitsCleanly(suite);
    }
  }
);
