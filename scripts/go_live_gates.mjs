#!/usr/bin/env node
import 'dotenv/config';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

const GO_LIVE_TIMEOUT_MS = Number(process.env.GO_LIVE_GATES_TIMEOUT_MS ?? '900000');
const GO_LIVE_OUTPUT_TAIL_LINES = Number(process.env.GO_LIVE_GATES_OUTPUT_TAIL_LINES ?? '120');
const GO_LIVE_INVARIANT_LIMIT = Number(process.env.GO_LIVE_GATES_INVARIANT_LIMIT ?? '25');
const GO_LIVE_TEST_BASE_URL = process.env.GO_LIVE_TEST_BASE_URL
  ?? process.env.TEST_BASE_URL
  ?? 'http://127.0.0.1:3105';

const PRODUCTION_LIKE_ENV = Object.freeze({
  DEV_AUTO_REPAIR_DEFAULTS: 'false',
  ENABLE_SCHEDULER: 'false',
  INVARIANTS_ALLOW_ALL_TENANTS: 'false',
  TEST_BASE_URL: GO_LIVE_TEST_BASE_URL,
  API_BASE_URL: process.env.API_BASE_URL ?? GO_LIVE_TEST_BASE_URL
});

function tailOutput(text, lineCount = GO_LIVE_OUTPUT_TAIL_LINES) {
  const lines = String(text ?? '').split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - lineCount)).join('\n').trim();
}

function getChildEnv() {
  const childEnv = { ...process.env, ...PRODUCTION_LIKE_ENV };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('NODE_TEST')) {
      delete childEnv[key];
    }
  }
  return childEnv;
}

function getTenantIdFromOutput(output) {
  const match = /\[go_live_gate_tenant_id\]\s+([0-9a-fA-F-]{36})/.exec(String(output ?? ''));
  return match?.[1] ?? null;
}

function parseSummaryFromOutput(output, summaryCode) {
  let summary = null;
  const lines = String(output ?? '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.code === summaryCode) {
        summary = parsed;
      }
    } catch {
      // Ignore non-JSON and malformed JSON lines from subprocess output.
    }
  }
  return summary;
}

function isGateStatus(value) {
  return value === 'pass' || value === 'fail';
}

function normalizeGateResults(gates) {
  if (!Array.isArray(gates)) {
    throw new Error('GO_LIVE_GATES_TEST_SUMMARY.gates must be an array');
  }
  return gates.map((gate, index) => {
    const gateCode = gate?.gateCode;
    const status = gate?.status;
    const elapsedMs = Number(gate?.elapsedMs);
    if (typeof gateCode !== 'string' || gateCode.length === 0) {
      throw new Error(`GO_LIVE_GATES_TEST_SUMMARY.gates[${index}].gateCode must be a non-empty string`);
    }
    if (!isGateStatus(status)) {
      throw new Error(`GO_LIVE_GATES_TEST_SUMMARY.gates[${index}].status must be "pass" or "fail"`);
    }
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
      throw new Error(`GO_LIVE_GATES_TEST_SUMMARY.gates[${index}].elapsedMs must be a finite number >= 0`);
    }
    const normalized = {
      gateCode,
      status,
      elapsedMs
    };
    if (gate?.details && typeof gate.details === 'object' && !Array.isArray(gate.details)) {
      normalized.details = gate.details;
    }
    return normalized;
  });
}

function printFailureTails(gate) {
  console.error(`[${gate.code}] failed`);
  if (gate.stdoutTail) {
    console.error('[stdout tail]');
    console.error(gate.stdoutTail);
  }
  if (gate.stderrTail) {
    console.error('[stderr tail]');
    console.error(gate.stderrTail);
  }
}

function printSummaryAndExit({
  passed,
  tenantId,
  invariantsTenantId,
  gates,
  elapsedMs,
  invariants
}, exitCode) {
  console.log(JSON.stringify({
    code: 'GO_LIVE_GATES_SUMMARY',
    passed,
    tenantId,
    invariantsTenantId,
    gates,
    elapsedMs,
    invariants
  }));
  process.exit(exitCode);
}

async function runGateCommand(code, args) {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: process.cwd(),
      env: getChildEnv(),
      timeout: GO_LIVE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024
    });
    return {
      code,
      passed: true,
      elapsedMs: Date.now() - startedAt,
      stdout,
      stderr,
      stdoutTail: tailOutput(stdout),
      stderrTail: tailOutput(stderr)
    };
  } catch (error) {
    const stdout = String(error?.stdout ?? '');
    const stderr = String(error?.stderr ?? '');
    return {
      code,
      passed: false,
      elapsedMs: Date.now() - startedAt,
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      signal: error?.signal ?? null,
      errorMessage: error?.message ?? 'command failed',
      stdout,
      stderr,
      stdoutTail: tailOutput(stdout),
      stderrTail: tailOutput(stderr)
    };
  }
}

const runStartedAt = Date.now();

const goLiveTestGate = await runGateCommand('GO_LIVE_TEST_SUITE', [
  '--test',
  '--test-reporter=spec',
  'tests/ops/go-live-gates.test.mjs'
]);

if (!goLiveTestGate.passed) {
  printFailureTails(goLiveTestGate);
  printSummaryAndExit({
    passed: false,
    tenantId: null,
    invariantsTenantId: null,
    gates: [],
    elapsedMs: Date.now() - runStartedAt,
    invariants: {
      passed: false,
      elapsedMs: 0
    }
  }, 1);
}

const goLiveTestOutput = `${goLiveTestGate.stdout}\n${goLiveTestGate.stderr}`;
const parsedTestSummary = parseSummaryFromOutput(goLiveTestOutput, 'GO_LIVE_GATES_TEST_SUMMARY');
const fallbackTenantId = getTenantIdFromOutput(goLiveTestOutput);

if (!parsedTestSummary) {
  console.error('GO_LIVE_GATES_TEST_SUMMARY_PARSE_FAILED unable to parse GO_LIVE_GATES_TEST_SUMMARY from test output');
  if (fallbackTenantId) {
    console.error(`GO_LIVE_GATES_TEST_SUMMARY_PARSE_FAILED fallbackTenantId=${fallbackTenantId}`);
  }
  printSummaryAndExit({
    passed: false,
    tenantId: fallbackTenantId,
    invariantsTenantId: null,
    gates: [],
    elapsedMs: Date.now() - runStartedAt,
    invariants: {
      passed: false,
      elapsedMs: 0
    }
  }, 1);
}

if (typeof parsedTestSummary.tenantId !== 'string' || parsedTestSummary.tenantId.length === 0) {
  console.error('GO_LIVE_GATES_TEST_SUMMARY_INVALID tenantId is missing or invalid');
  printSummaryAndExit({
    passed: false,
    tenantId: null,
    invariantsTenantId: null,
    gates: [],
    elapsedMs: Date.now() - runStartedAt,
    invariants: {
      passed: false,
      elapsedMs: 0
    }
  }, 1);
}

if (fallbackTenantId && fallbackTenantId !== parsedTestSummary.tenantId) {
  console.error(
    `GO_LIVE_GATES_TENANT_MISMATCH markerTenantId=${fallbackTenantId} summaryTenantId=${parsedTestSummary.tenantId}`
  );
  printSummaryAndExit({
    passed: false,
    tenantId: parsedTestSummary.tenantId,
    invariantsTenantId: null,
    gates: [],
    elapsedMs: Date.now() - runStartedAt,
    invariants: {
      passed: false,
      elapsedMs: 0
    }
  }, 1);
}

let gates;
try {
  gates = normalizeGateResults(parsedTestSummary.gates);
} catch (error) {
  console.error(`GO_LIVE_GATES_TEST_SUMMARY_INVALID ${error?.message ?? 'invalid gates payload'}`);
  printSummaryAndExit({
    passed: false,
    tenantId: parsedTestSummary.tenantId,
    invariantsTenantId: null,
    gates: [],
    elapsedMs: Date.now() - runStartedAt,
    invariants: {
      passed: false,
      elapsedMs: 0
    }
  }, 1);
}

const tenantId = parsedTestSummary.tenantId;
const invariantsTenantId = tenantId;

const strictInvariantGate = await runGateCommand('STRICT_INVARIANTS', [
  'scripts/inventory_invariants_check.mjs',
  '--strict',
  '--tenant-id',
  invariantsTenantId,
  '--limit',
  String(GO_LIVE_INVARIANT_LIMIT)
]);

const invariants = {
  passed: strictInvariantGate.passed,
  elapsedMs: strictInvariantGate.elapsedMs
};

if (tenantId !== invariantsTenantId) {
  console.error(`GO_LIVE_GATES_TENANT_PIN_VIOLATION tenantId=${tenantId} invariantsTenantId=${invariantsTenantId}`);
  printSummaryAndExit({
    passed: false,
    tenantId,
    invariantsTenantId,
    gates,
    elapsedMs: Date.now() - runStartedAt,
    invariants
  }, 1);
}

if (!strictInvariantGate.passed) {
  printFailureTails(strictInvariantGate);
  printSummaryAndExit({
    passed: false,
    tenantId,
    invariantsTenantId,
    gates,
    elapsedMs: Date.now() - runStartedAt,
    invariants
  }, 1);
}

printSummaryAndExit({
  passed: true,
  tenantId,
  invariantsTenantId,
  gates,
  elapsedMs: Date.now() - runStartedAt,
  invariants
}, 0);
