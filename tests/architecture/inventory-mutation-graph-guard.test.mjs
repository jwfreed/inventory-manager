import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const SRC_ROOT = path.resolve(process.cwd(), 'src');
const WRAPPER_SOURCE = path.resolve(
  process.cwd(),
  'src/modules/platform/application/runInventoryCommand.ts'
);
const TRANSFERS_SERVICE = path.resolve(process.cwd(), 'src/services/transfers.service.ts');
const PUTAWAYS_SERVICE = path.resolve(process.cwd(), 'src/services/putaways.service.ts');
const ORDER_TO_CASH_SERVICE = path.resolve(process.cwd(), 'src/services/orderToCash.service.ts');
const RECEIPTS_SERVICE = path.resolve(process.cwd(), 'src/services/receipts.service.ts');
const COUNTS_SERVICE = path.resolve(process.cwd(), 'src/services/counts.service.ts');
const ADJUSTMENTS_POSTING_SERVICE = path.resolve(process.cwd(), 'src/services/adjustments/posting.service.ts');

const MUTATION_PATTERNS = [
  /\bcreateInventoryMovement\(/,
  /\bcreateInventoryMovementLine\(/,
  /\brelocateTransferCostLayersInTx\(/,
  /\breverseTransferCostLayersInTx\(/
];

const WRAPPER_MANAGED_FILES = new Map([
  [ORDER_TO_CASH_SERVICE, /\brunInventoryCommand(?:<[^>]+>)?\(/],
  [RECEIPTS_SERVICE, /\brunInventoryCommand(?:<[^>]+>)?\(/],
  [COUNTS_SERVICE, /\brunInventoryCommand(?:<[^>]+>)?\(/],
  [ADJUSTMENTS_POSTING_SERVICE, /\brunInventoryCommand(?:<[^>]+>)?\(/],
  [PUTAWAYS_SERVICE, /\brunInventoryCommand(?:<[^>]+>)?\(/],
  [TRANSFERS_SERVICE, /\brunInventoryCommand(?:<[^>]+>)?\(/]
]);

const DOCUMENTED_PENDING_EXCEPTIONS = new Set([
  path.resolve(process.cwd(), 'src/services/licensePlates.service.ts'),
  path.resolve(process.cwd(), 'src/services/workOrderExecution.service.ts')
]);

const HELPER_IMPLEMENTATION_FILES = new Set([
  path.resolve(process.cwd(), 'src/services/transferCosting.service.ts'),
  path.resolve(process.cwd(), 'src/domains/inventory/internal/ledgerWriter.ts')
]);

async function walkTsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkTsFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

test('inventory mutation graph is constrained to wrapper-managed files or documented backlog exceptions', async () => {
  const files = await walkTsFiles(SRC_ROOT);
  const violations = [];

  for (const filePath of files) {
    const source = await fs.readFile(filePath, 'utf8');
    const isMutationFile = MUTATION_PATTERNS.some((pattern) => pattern.test(source));
    if (!isMutationFile) continue;

    if (HELPER_IMPLEMENTATION_FILES.has(filePath)) {
      continue;
    }

    const wrapperPattern = WRAPPER_MANAGED_FILES.get(filePath);
    if (wrapperPattern) {
      assert.match(
        source,
        wrapperPattern,
        `${path.relative(process.cwd(), filePath)} must use runInventoryCommand() for inventory mutation orchestration`
      );
      continue;
    }

    if (DOCUMENTED_PENDING_EXCEPTIONS.has(filePath)) {
      continue;
    }

    violations.push(path.relative(process.cwd(), filePath));
  }

  assert.equal(
    violations.length,
    0,
    [
      'Inventory mutation path detected outside canonical mutation shell.',
      'Either migrate the path to runInventoryCommand() or document it in the pending exception set intentionally.',
      ...violations
    ].join('\n')
  );
});

test('transfer-family lock target ordering is deterministic', async () => {
  const [transfersSource, putawaysSource] = await Promise.all([
    fs.readFile(TRANSFERS_SERVICE, 'utf8'),
    fs.readFile(PUTAWAYS_SERVICE, 'utf8')
  ]);

  assert.match(
    transfersSource,
    /function buildTransferLockTargets[\s\S]*\.sort\(compareInventoryLockTarget\)/,
    'buildTransferLockTargets must sort lock targets deterministically'
  );
  assert.match(
    putawaysSource,
    /return targets\.sort\(\(left, right\) =>[\s\S]*warehouseId\.localeCompare[\s\S]*itemId\.localeCompare/,
    'postPutaway lock targets must be sorted by warehouse and item'
  );
});

test('transfer replay responses are reconstructed from authoritative movement data', async () => {
  const source = await fs.readFile(TRANSFERS_SERVICE, 'utf8');

  assert.match(source, /\basync function reconstructTransferReplayResult\(/);
  assert.match(source, /FROM inventory_movements/);
  assert.match(source, /FROM inventory_movement_lines iml/);
  assert.match(source, /created:\s*false/);
  assert.match(source, /replayed:\s*true/);
  assert.match(
    source,
    /onReplay:\s*async\s*\(\{\s*client:\s*txClient,\s*responseBody\s*\}\)\s*=>[\s\S]*reconstructTransferReplayResult\(/,
    'transfer replay path must rebuild response data from authoritative movement scope'
  );
});

test('runInventoryCommand keeps authoritative event append before projection ops', async () => {
  const source = await fs.readFile(WRAPPER_SOURCE, 'utf8');
  assert.match(
    source,
    /const sortedLockTargets = \[\.\.\.lockTargets\]\.sort\(compareInventoryCommandLockTarget\)/,
    'runInventoryCommand must sort lock targets deterministically before acquiring advisory locks'
  );
  const appendIndex = source.indexOf('appendInventoryEventsWithDispatch(');
  const projectionIndex = source.indexOf('for (const projectionOp of execution.projectionOps ?? [])');

  assert.notEqual(appendIndex, -1, 'runInventoryCommand must append authoritative events');
  assert.notEqual(projectionIndex, -1, 'runInventoryCommand must execute projection ops');
  assert.ok(appendIndex < projectionIndex, 'authoritative event append must precede projection ops');
});
