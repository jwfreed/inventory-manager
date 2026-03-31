import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

const SUMMARY_TEST_TIMEOUT_MS = Number(process.env.GO_LIVE_SUMMARY_SHAPE_TIMEOUT_MS ?? '1800000');
const OUTPUT_TAIL_LINES = Number(process.env.GO_LIVE_SUMMARY_SHAPE_OUTPUT_TAIL_LINES ?? '120');
const EXPECTED_GATE_CODES = Object.freeze([
  'E2E_FLOW',
  'TRANSFER_API',
  'COST_LAYER_RELOCATION',
  'WAREHOUSE_SCOPED_ATP',
  'RECEIPT_VOID_SAFE',
  'CYCLE_COUNTS',
  'STRICT_INVARIANTS'
]);

function tailOutput(text, lineCount = OUTPUT_TAIL_LINES) {
  const lines = String(text ?? '').split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - lineCount)).join('\n').trim();
}

function parseJsonSummary(output, code) {
  let summary = null;
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.code === code) {
        summary = parsed;
      }
    } catch {
      // Ignore non-summary lines.
    }
  }
  return summary;
}

function parseTenantMarker(output) {
  const match = /\[go_live_gate_tenant_id\]\s+([0-9a-fA-F-]{36})/.exec(String(output ?? ''));
  return match?.[1] ?? null;
}

function createChildEnv(baseUrl, extraEnv = {}) {
  const env = {
    ...process.env,
    ...extraEnv,
    DEV_AUTO_REPAIR_DEFAULTS: 'false',
    ENABLE_SCHEDULER: 'false',
    INVARIANTS_ALLOW_ALL_TENANTS: 'false',
    TEST_BASE_URL: baseUrl,
    API_BASE_URL: baseUrl
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST')) {
      delete env[key];
    }
  }
  return env;
}

async function runSubprocessOrFail({ label, args, env }) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: process.cwd(),
      env,
      timeout: SUMMARY_TEST_TIMEOUT_MS,
      maxBuffer: 12 * 1024 * 1024
    });
    return { stdout, stderr };
  } catch (error) {
    const stdout = String(error?.stdout ?? '');
    const stderr = String(error?.stderr ?? '');
    assert.fail(
      [
        `${label} failed`,
        `[exitCode=${error?.code ?? 'unknown'} signal=${error?.signal ?? 'none'}]`,
        '[stdout tail]',
        tailOutput(stdout),
        '[stderr tail]',
        tailOutput(stderr)
      ].filter(Boolean).join('\n')
    );
  }
}

function assertGateResultShape(gates, summaryCode) {
  assert.ok(Array.isArray(gates), `${summaryCode}.gates must be an array`);
  assert.ok(gates.length > 0, `${summaryCode}.gates must contain gate records`);
  for (const [index, gate] of gates.entries()) {
    assert.equal(typeof gate?.gateCode, 'string', `${summaryCode}.gates[${index}].gateCode must be a string`);
    assert.ok(gate.gateCode.length > 0, `${summaryCode}.gates[${index}].gateCode must not be empty`);
    assert.ok(
      gate?.status === 'pass' || gate?.status === 'fail',
      `${summaryCode}.gates[${index}].status must be "pass" or "fail"`
    );
    assert.equal(typeof gate?.elapsedMs, 'number', `${summaryCode}.gates[${index}].elapsedMs must be a number`);
    assert.ok(Number.isFinite(gate.elapsedMs), `${summaryCode}.gates[${index}].elapsedMs must be finite`);
    assert.ok(gate.elapsedMs >= 0, `${summaryCode}.gates[${index}].elapsedMs must be >= 0`);
  }
}

test(
  'go-live summaries publish stable gate shapes and tenant pinning',
  { timeout: SUMMARY_TEST_TIMEOUT_MS + 120000 },
  async () => {
    const gateTestBaseUrl = process.env.GO_LIVE_SUMMARY_SHAPE_GATE_BASE_URL ?? 'http://127.0.0.1:3115';
    const gateRunnerBaseUrl = process.env.GO_LIVE_SUMMARY_SHAPE_RUNNER_BASE_URL ?? 'http://127.0.0.1:3116';

    const goLiveTest = await runSubprocessOrFail({
      label: 'go-live test suite subprocess',
      args: ['--test', '--test-reporter=spec', 'tests/ops/go-live-gates.test.mjs'],
      env: createChildEnv(gateTestBaseUrl, {
        GO_LIVE_GATE_BASE_URL: gateTestBaseUrl
      })
    });

    const testOutput = `${goLiveTest.stdout}\n${goLiveTest.stderr}`;
    const testSummary = parseJsonSummary(testOutput, 'GO_LIVE_GATES_TEST_SUMMARY');
    assert.ok(
      testSummary,
      [
        'GO_LIVE_GATES_TEST_SUMMARY line missing from go-live test suite output',
        '[stdout tail]',
        tailOutput(goLiveTest.stdout),
        '[stderr tail]',
        tailOutput(goLiveTest.stderr)
      ].join('\n')
    );
    assert.equal(testSummary.passed, true, 'GO_LIVE_GATES_TEST_SUMMARY.passed must be true');
    assert.equal(typeof testSummary.tenantId, 'string', 'GO_LIVE_GATES_TEST_SUMMARY.tenantId must be a string');
    const markerTenantId = parseTenantMarker(testOutput);
    assert.ok(markerTenantId, 'go-live test output must include [go_live_gate_tenant_id] marker');
    assert.equal(markerTenantId, testSummary.tenantId, 'tenant marker must match GO_LIVE_GATES_TEST_SUMMARY.tenantId');
    assertGateResultShape(testSummary.gates, 'GO_LIVE_GATES_TEST_SUMMARY');
    assert.deepEqual(
      testSummary.gates.map((gate) => gate.gateCode),
      EXPECTED_GATE_CODES,
      'GO_LIVE_GATES_TEST_SUMMARY gateCode order must remain stable'
    );

    const goLiveRunner = await runSubprocessOrFail({
      label: 'go-live runner subprocess',
      args: ['scripts/go_live_gates.mjs'],
      env: createChildEnv(gateRunnerBaseUrl, {
        GO_LIVE_TEST_BASE_URL: gateRunnerBaseUrl,
        GO_LIVE_GATES_TEST_SUMMARY_JSON: JSON.stringify(testSummary)
      })
    });

    const runnerOutput = `${goLiveRunner.stdout}\n${goLiveRunner.stderr}`;
    const runnerSummary = parseJsonSummary(runnerOutput, 'GO_LIVE_GATES_SUMMARY');
    assert.ok(
      runnerSummary,
      [
        'GO_LIVE_GATES_SUMMARY line missing from go-live runner output',
        '[stdout tail]',
        tailOutput(goLiveRunner.stdout),
        '[stderr tail]',
        tailOutput(goLiveRunner.stderr)
      ].join('\n')
    );
    assert.equal(runnerSummary.passed, true, 'GO_LIVE_GATES_SUMMARY.passed must be true');
    assert.equal(typeof runnerSummary.tenantId, 'string', 'GO_LIVE_GATES_SUMMARY.tenantId must be a string');
    assert.equal(
      typeof runnerSummary.invariantsTenantId,
      'string',
      'GO_LIVE_GATES_SUMMARY.invariantsTenantId must be a string'
    );
    assert.equal(
      runnerSummary.tenantId,
      runnerSummary.invariantsTenantId,
      'GO_LIVE_GATES_SUMMARY tenantId must equal invariantsTenantId'
    );
    assert.ok(
      runnerSummary.invariants && typeof runnerSummary.invariants === 'object',
      'GO_LIVE_GATES_SUMMARY.invariants must be present'
    );
    assert.equal(runnerSummary.invariants.passed, true, 'GO_LIVE_GATES_SUMMARY.invariants.passed must be true');
    assert.equal(
      typeof runnerSummary.invariants.elapsedMs,
      'number',
      'GO_LIVE_GATES_SUMMARY.invariants.elapsedMs must be a number'
    );
    assertGateResultShape(runnerSummary.gates, 'GO_LIVE_GATES_SUMMARY');
    assert.deepEqual(
      runnerSummary.gates.map((gate) => gate.gateCode),
      EXPECTED_GATE_CODES,
      'GO_LIVE_GATES_SUMMARY gateCode order must remain stable'
    );
  }
);
