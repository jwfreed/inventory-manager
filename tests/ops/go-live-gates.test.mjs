import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { getTestTenantWithValidTopology } from '../helpers/topologyTenant.mjs';
import { closeDbPool } from '../helpers/dbPool.mjs';
import { stopTestServer } from '../api/helpers/testServer.mjs';

const execFileAsync = promisify(execFile);

const GATE_TIMEOUT_MS = Number(process.env.GO_LIVE_GATE_TIMEOUT_MS ?? '240000');
const GATE_OUTPUT_TAIL_LINES = Number(process.env.GO_LIVE_GATE_OUTPUT_TAIL_LINES ?? '120');
const STRICT_INVARIANT_LIMIT = 25;
const GO_LIVE_GATE_TEST_BASE_URL = process.env.GO_LIVE_GATE_BASE_URL
  ?? process.env.TEST_BASE_URL
  ?? 'http://127.0.0.1:3105';

const PRODUCTION_LIKE_ENV = Object.freeze({
  DEV_AUTO_REPAIR_DEFAULTS: 'false',
  ENABLE_SCHEDULER: 'false',
  INVARIANTS_ALLOW_ALL_TENANTS: 'false',
  WAREHOUSE_DEFAULTS_REPAIR: process.env.WAREHOUSE_DEFAULTS_REPAIR ?? 'false',
  TEST_BASE_URL: GO_LIVE_GATE_TEST_BASE_URL,
  API_BASE_URL: process.env.API_BASE_URL ?? GO_LIVE_GATE_TEST_BASE_URL
});

const GATE_CODES = Object.freeze({
  E2E_FLOW: 'E2E_FLOW',
  TRANSFER_API: 'TRANSFER_API',
  COST_LAYER_RELOCATION: 'COST_LAYER_RELOCATION',
  WAREHOUSE_SCOPED_ATP: 'WAREHOUSE_SCOPED_ATP',
  RECEIPT_VOID_SAFE: 'RECEIPT_VOID_SAFE',
  CYCLE_COUNTS: 'CYCLE_COUNTS',
  STRICT_INVARIANTS: 'STRICT_INVARIANTS'
});

const STRICT_INVARIANT_SECTIONS = Object.freeze([
  'atp_oversell_detected',
  'negative_on_hand',
  'unmatched_cost_layers',
  'orphaned_cost_layers',
  'warehouse_default_completeness_invalid'
]);

const STABLE_GATE_ORDER = Object.freeze([
  GATE_CODES.E2E_FLOW,
  GATE_CODES.TRANSFER_API,
  GATE_CODES.COST_LAYER_RELOCATION,
  GATE_CODES.WAREHOUSE_SCOPED_ATP,
  GATE_CODES.RECEIPT_VOID_SAFE,
  GATE_CODES.CYCLE_COUNTS,
  GATE_CODES.STRICT_INVARIANTS
]);

const CHECKLIST_GATE_DEFINITIONS = Object.freeze([
  {
    gateCode: GATE_CODES.E2E_FLOW,
    testFile: 'tests/ops/retail-distribution-flow.test.mjs',
    expectedStdoutPattern: /retail distribution flow: WO->QA, QC accept, transfer to store, reserve\+fulfill store scoped/
  },
  {
    gateCode: GATE_CODES.TRANSFER_API,
    testFile: 'tests/ops/transfer-idempotency.test.mjs',
    expectedStdoutPattern: /inventory transfer idempotency defaults omitted occurredAt once and replays deterministically/
  },
  {
    gateCode: GATE_CODES.COST_LAYER_RELOCATION,
    testFile: 'tests/ops/transfer-cost-relocation.test.mjs',
    testNamePattern: 'transfer relocation splits FIFO layers and conserves line costs',
    expectedStdoutPattern: /transfer relocation splits FIFO layers and conserves line costs/
  },
  {
    gateCode: GATE_CODES.WAREHOUSE_SCOPED_ATP,
    testFile: 'tests/ops/multi-warehouse-scoping.test.mjs',
    expectedStdoutPattern: /reservations do not consume supply across warehouses/
  },
  {
    gateCode: GATE_CODES.RECEIPT_VOID_SAFE,
    testFile: 'tests/ops/receipt-void-reversal.test.mjs',
    expectedStdoutPattern: /voiding a receipt posts an exact reversal and remains idempotent under concurrency/
  },
  {
    gateCode: GATE_CODES.CYCLE_COUNTS,
    testFile: 'tests/ops/cycle-count-idempotency.test.mjs',
    expectedStdoutPattern: /cycle count post idempotency: same key\+payload replays; different payload conflicts; incomplete is detected/
  }
]);

function tailOutput(text, lineCount = GATE_OUTPUT_TAIL_LINES) {
  const lines = String(text ?? '').split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - lineCount)).join('\n').trim();
}

function parseTenantMarker(output) {
  const match = /\[go_live_gate_tenant_id\]\s+([0-9a-fA-F-]{36})/.exec(String(output ?? ''));
  return match?.[1] ?? null;
}

function normalizeDetailValue(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => String(entry).slice(0, 160));
  }
  if (typeof value === 'string') {
    return value.slice(0, 160);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  return String(value).slice(0, 160);
}

function boundedDetails(details) {
  if (!details || typeof details !== 'object') return undefined;
  const normalized = Object.fromEntries(
    Object.entries(details)
      .slice(0, 5)
      .map(([key, value]) => [key, normalizeDetailValue(value)])
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function createChildEnv() {
  const childEnv = { ...process.env, ...PRODUCTION_LIKE_ENV };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('NODE_TEST')) {
      delete childEnv[key];
    }
  }
  return childEnv;
}

async function runSubprocessTestFile(gate) {
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        '--test',
        '--test-reporter=spec',
        ...(gate.testNamePattern ? ['--test-name-pattern', gate.testNamePattern] : []),
        gate.testFile
      ],
      {
        cwd: process.cwd(),
        env: createChildEnv(),
        timeout: GATE_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      }
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stdout = String(error?.stdout ?? '');
    stderr = String(error?.stderr ?? '');
    assert.fail(
      [
        `Gate subprocess failed for ${gate.gateCode} (${gate.testFile})`,
        `[exitCode=${error?.code ?? 'unknown'} signal=${error?.signal ?? 'none'}]`,
        '[stdout tail]',
        tailOutput(stdout),
        '[stderr tail]',
        tailOutput(stderr)
      ].filter(Boolean).join('\n')
    );
  }
  const elapsedMs = Date.now() - startedAt;
  assert.match(
    stdout,
    gate.expectedStdoutPattern,
    [
      `Missing representative assertion output for ${gate.gateCode} (${gate.testFile})`,
      '[stdout tail]',
      tailOutput(stdout),
      '[stderr tail]',
      tailOutput(stderr)
    ].filter(Boolean).join('\n')
  );
  return {
    gateCode: gate.gateCode,
    status: 'pass',
    elapsedMs,
    details: boundedDetails({
      suiteFile: gate.testFile,
      testNamePattern: gate.testNamePattern ?? null
    })
  };
}

function getInvariantCount(stdout, sectionName) {
  const match = new RegExp(`\\[${sectionName}\\] count=(\\d+)`).exec(stdout);
  assert.ok(match, `Invariant section missing from output: ${sectionName}`);
  return Number(match[1]);
}

let gateTenantId = null;

test(
  'Phase 5 go-live readiness gates enforce production checklist behaviors',
  { timeout: 900000 },
  async () => {
    const gateResults = [];
    const startedAt = Date.now();

    for (const gate of CHECKLIST_GATE_DEFINITIONS) {
      gateResults.push(await runSubprocessTestFile(gate));
    }

    const session = await getTestTenantWithValidTopology({
      tenantName: 'Phase 5 Go-Live Gate Strict Tenant'
    });
    const tenantId = session.tenant?.id;
    assert.ok(tenantId, 'tenantId is required for strict go-live gate');
    gateTenantId = tenantId;

    const strictStartedAt = Date.now();
    let strictStdout = '';
    let strictStderr = '';
    try {
      const strictRun = await execFileAsync(
        process.execPath,
        ['scripts/inventory_invariants_check.mjs', '--strict', '--tenant-id', tenantId, '--limit', String(STRICT_INVARIANT_LIMIT)],
        {
          cwd: process.cwd(),
          env: createChildEnv(),
          timeout: GATE_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024
        }
      );
      strictStdout = strictRun.stdout;
      strictStderr = strictRun.stderr;
    } catch (error) {
      strictStdout = String(error?.stdout ?? '');
      strictStderr = String(error?.stderr ?? '');
      assert.fail(
        [
          'Strict invariants subprocess failed for go-live gate',
          `[exitCode=${error?.code ?? 'unknown'} signal=${error?.signal ?? 'none'} tenantId=${tenantId}]`,
          '[stdout tail]',
          tailOutput(strictStdout),
          '[stderr tail]',
          tailOutput(strictStderr)
        ].filter(Boolean).join('\n')
      );
    }

    for (const sectionName of STRICT_INVARIANT_SECTIONS) {
      assert.equal(getInvariantCount(strictStdout, sectionName), 0, `strict invariant ${sectionName} must remain zero`);
    }

    gateResults.push({
      gateCode: GATE_CODES.STRICT_INVARIANTS,
      status: 'pass',
      elapsedMs: Date.now() - strictStartedAt,
      details: boundedDetails({
        script: 'scripts/inventory_invariants_check.mjs',
        limit: STRICT_INVARIANT_LIMIT,
        sections: STRICT_INVARIANT_SECTIONS
      })
    });

    assert.deepEqual(
      gateResults.map((gate) => gate.gateCode),
      STABLE_GATE_ORDER,
      'go-live gate order must remain stable for CI dashboards'
    );

    const elapsedMs = Date.now() - startedAt;
    const tenantMarker = `[go_live_gate_tenant_id] ${tenantId}`;
    const summary = {
      code: 'GO_LIVE_GATES_TEST_SUMMARY',
      passed: true,
      tenantId,
      gates: gateResults,
      elapsedMs
    };

    assert.equal(parseTenantMarker(tenantMarker), summary.tenantId, 'tenant marker must match summary tenantId');
    console.log(tenantMarker);
    console.log(JSON.stringify(summary));
  }
);

test.after(async () => {
  await closeDbPool();
  await stopTestServer();
  if (gateTenantId) {
    console.log(`[go_live_gate_last_tenant_id] ${gateTenantId}`);
  }
});
