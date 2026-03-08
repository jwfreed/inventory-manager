import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const WRAPPER_SOURCE = path.resolve(
  process.cwd(),
  'src/modules/platform/application/runInventoryCommand.ts'
);
const REPLAY_SUPPORT_SOURCE = path.resolve(
  process.cwd(),
  'src/modules/platform/application/inventoryMutationSupport.ts'
);
const EVENT_REGISTRY_SOURCE = path.resolve(
  process.cwd(),
  'src/modules/platform/application/inventoryEventRegistry.ts'
);
const EVENT_APPEND_SOURCE = path.resolve(
  process.cwd(),
  'src/modules/platform/infrastructure/inventoryEvents.ts'
);
const LICENSE_PLATES_SERVICE = path.resolve(process.cwd(), 'src/services/licensePlates.service.ts');
const COUNTS_SERVICE = path.resolve(process.cwd(), 'src/services/counts.service.ts');
const ADJUSTMENTS_POSTING_SERVICE = path.resolve(process.cwd(), 'src/services/adjustments/posting.service.ts');
const TRANSFERS_SERVICE = path.resolve(process.cwd(), 'src/services/transfers.service.ts');
const QC_SERVICE = path.resolve(process.cwd(), 'src/services/qc.service.ts');
const WORK_ORDER_EXECUTION_SERVICE = path.resolve(
  process.cwd(),
  'src/services/workOrderExecution.service.ts'
);

function extractFunctionBody(source, functionName) {
  const markers = [
    `export async function ${functionName}`,
    `async function ${functionName}`,
    `function ${functionName}`
  ];
  const marker = markers
    .map((candidate) => ({ candidate, index: source.indexOf(candidate) }))
    .find((candidate) => candidate.index !== -1);

  assert.ok(marker, `expected function marker for ${functionName}`);

  const paramsOpenIndex = source.indexOf('(', marker.index);
  assert.notEqual(paramsOpenIndex, -1, `missing parameter list for ${functionName}`);

  let paramsDepth = 0;
  let paramsCloseIndex = -1;
  for (let i = paramsOpenIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        paramsCloseIndex = i;
        break;
      }
    }
  }
  assert.notEqual(paramsCloseIndex, -1, `missing closing parenthesis for ${functionName}`);

  let openBraceIndex = -1;
  let inReturnType = false;
  let angleDepth = 0;
  let typeBraceDepth = 0;
  let lastNonWhitespaceChar = '';

  for (let i = paramsCloseIndex + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === ':' && !inReturnType && !lastNonWhitespaceChar) {
      inReturnType = true;
      lastNonWhitespaceChar = char;
      continue;
    }
    if (!inReturnType && /\s/.test(char)) {
      continue;
    }
    if (!inReturnType && char === '{') {
      openBraceIndex = i;
      break;
    }
    if (inReturnType) {
      if (char === '<') {
        angleDepth += 1;
      } else if (char === '>') {
        angleDepth = Math.max(0, angleDepth - 1);
      } else if (char === '{') {
        if (angleDepth === 0 && typeBraceDepth === 0 && lastNonWhitespaceChar !== ':') {
          openBraceIndex = i;
          break;
        }
        typeBraceDepth += 1;
      } else if (char === '}') {
        typeBraceDepth = Math.max(0, typeBraceDepth - 1);
      }
    }
    if (!/\s/.test(char)) {
      lastNonWhitespaceChar = char;
    }
  }
  assert.notEqual(openBraceIndex, -1, `missing opening brace for ${functionName}`);

  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBraceIndex + 1, i);
      }
    }
  }

  throw new Error(`failed to parse function body for ${functionName}`);
}

const DAG_NODES = [
  { file: TRANSFERS_SERVICE, functionName: 'transferInventory', label: 'transferInventory' },
  { file: TRANSFERS_SERVICE, functionName: 'voidTransferMovement', label: 'voidTransferMovement' },
  { file: QC_SERVICE, functionName: 'createQcEvent', label: 'createQcEvent' },
  { file: LICENSE_PLATES_SERVICE, functionName: 'moveLicensePlate', label: 'moveLicensePlate' },
  { file: COUNTS_SERVICE, functionName: 'postInventoryCount', label: 'postInventoryCount' },
  { file: ADJUSTMENTS_POSTING_SERVICE, functionName: 'postInventoryAdjustment', label: 'postInventoryAdjustment' },
  { file: WORK_ORDER_EXECUTION_SERVICE, functionName: 'postWorkOrderIssue', label: 'postWorkOrderIssue' },
  { file: WORK_ORDER_EXECUTION_SERVICE, functionName: 'postWorkOrderCompletion', label: 'postWorkOrderCompletion' },
  { file: WORK_ORDER_EXECUTION_SERVICE, functionName: 'reportWorkOrderScrap', label: 'reportWorkOrderScrap' },
  { file: WORK_ORDER_EXECUTION_SERVICE, functionName: 'recordWorkOrderBatch', label: 'recordWorkOrderBatch' },
  {
    file: WORK_ORDER_EXECUTION_SERVICE,
    functionName: 'voidWorkOrderProductionReport',
    label: 'voidWorkOrderProductionReport'
  }
];

const FORBIDDEN_EDGE_PATTERNS = [
  [/\bwithTransactionRetry\(/, 'must not own a manual retry shell'],
  [/\bwithTransaction\(/, 'must not own a manual transaction shell'],
  [/\bappendInventoryEvent(?:sWithDispatch|WithDispatch)?\(/, 'must not append authoritative events directly'],
  [/\benqueueInventoryMovementPosted\(/, 'must not enqueue authoritative movement events directly'],
  [/\bacquireAtpLocks\(/, 'must not acquire ATP locks directly'],
  [/\bcreateAtpLockContext\(/, 'must not create ATP lock contexts directly'],
  [/\bassertAtpLockHeldOrThrow\(/, 'must not bypass wrapper lock ownership'],
  [/\bapplyInventoryBalanceDelta\(/, 'must route compatibility projection writes through projection ops']
];

test('license plate and manufacturing mutation dag entrypoints stay wrapper-managed', async () => {
  const uniqueFiles = [...new Set(DAG_NODES.map((node) => node.file))];
  const sourceEntries = await Promise.all(
    uniqueFiles.map(async (filePath) => [filePath, await readFile(filePath, 'utf8')])
  );
  const sources = new Map(sourceEntries);

  for (const node of DAG_NODES) {
    const source = sources.get(node.file);
    assert.ok(source, `missing source for ${node.label}`);
    const body = extractFunctionBody(source, node.functionName);

    assert.match(
      body,
      /\brunInventoryCommand(?:<[^>]+>)?\(/,
      `${node.label} must route mutation orchestration through runInventoryCommand()`
    );

    for (const [pattern, message] of FORBIDDEN_EDGE_PATTERNS) {
      assert.doesNotMatch(body, pattern, `${node.label} ${message}`);
    }
  }
});

test('migrated mutation entrypoints do not create authoritative movement rows outside runInventoryCommand', async () => {
  const uniqueFiles = [...new Set(DAG_NODES.map((node) => node.file))];
  const sourceEntries = await Promise.all(
    uniqueFiles.map(async (filePath) => [filePath, await readFile(filePath, 'utf8')])
  );
  const sources = new Map(sourceEntries);

  for (const node of DAG_NODES) {
    const source = sources.get(node.file);
    assert.ok(source, `missing source for ${node.label}`);
    const body = extractFunctionBody(source, node.functionName);
    if (/\bcreateInventoryMovement(?:Line)?\(/.test(body)) {
      assert.match(
        body,
        /\brunInventoryCommand(?:<[^>]+>)?\(/,
        `${node.label} must not create authoritative movement rows outside runInventoryCommand()`
      );
    }
  }
});

test('migrated movement writers persist deterministic hashes from authoritative movements', async () => {
  const [transferSource, licenseSource, workOrderSource] = await Promise.all([
    readFile(TRANSFERS_SERVICE, 'utf8'),
    readFile(LICENSE_PLATES_SERVICE, 'utf8'),
    readFile(WORK_ORDER_EXECUTION_SERVICE, 'utf8')
  ]);

  for (const [source, functionName] of [
    [transferSource, 'executeTransferInventoryMutation'],
    [transferSource, 'voidTransferMovement'],
    [licenseSource, 'moveLicensePlate'],
    [workOrderSource, 'postWorkOrderIssue'],
    [workOrderSource, 'postWorkOrderCompletion'],
    [workOrderSource, 'recordWorkOrderBatch'],
    [workOrderSource, 'voidWorkOrderProductionReport']
  ]) {
    const body = extractFunctionBody(source, functionName);
    if (/\bsortDeterministicMovementLines\(/.test(body)) {
      assert.match(
        body,
        /\bsortDeterministicMovementLines\(/,
        `${functionName} must create movement lines in deterministic order`
      );
    }
    assert.match(
      body,
      /\bpersistMovementDeterministicHashFromLedger\(|\bbuildMovementDeterministicHash\(/,
      `${functionName} must persist a deterministic movement hash`
    );
    assert.match(
      body,
      /\bbuildInventoryBalanceProjectionOp\(|\bbuildTransferReversalBalanceProjectionOp\(/,
      `${functionName} must express inventory_balance compatibility writes through projection ops`
    );
  }

  assert.match(
    licenseSource,
    /\bbuildPostedDocumentReplayResult\(/,
    'license plate replay handling must rebuild from authoritative movement readiness'
  );
  assert.match(
    transferSource,
    /\bbuildTransferReplayResult\(/,
    'transfer replay handling must rebuild from authoritative movement readiness'
  );
  for (const helperName of [
    'buildWorkOrderIssueReplayResult',
    'buildWorkOrderCompletionReplayResult',
    'buildWorkOrderBatchReplayResult',
    'buildWorkOrderVoidReplayResult'
  ]) {
    const body = extractFunctionBody(workOrderSource, helperName);
    assert.match(
      body,
      /\bbuildPostedDocumentReplayResult\(/,
      `${helperName} must reconstruct replay responses from authoritative movement scope`
    );
  }
});

test('shared replay helper keys event repair by aggregate identity, event type, and version', async () => {
  const source = await readFile(REPLAY_SUPPORT_SOURCE, 'utf8');
  const body = extractFunctionBody(source, 'buildPostedDocumentReplayResult');

  const readinessIndex = body.indexOf('verifyAuthoritativeMovementReplayIntegrity(');
  const aggregateFetchIndex = body.indexOf('fetchAggregateView()');
  assert.notEqual(readinessIndex, -1, 'buildPostedDocumentReplayResult must verify authoritative movement integrity');
  assert.notEqual(aggregateFetchIndex, -1, 'buildPostedDocumentReplayResult must fetch the aggregate view');
  assert.ok(
    readinessIndex < aggregateFetchIndex,
    'buildPostedDocumentReplayResult must verify authoritative movement integrity before fetching aggregate state'
  );
  assert.match(
    source,
    /REPLAY_CORRUPTION_DETECTED/,
    'replay helper must fail closed with REPLAY_CORRUPTION_DETECTED on authoritative corruption'
  );
  assert.match(
    source,
    /MOVEMENT_HASH_REQUIRED_AFTER_MIGRATION_TS/,
    'replay helper must define the post-migration hash cutoff'
  );
  assert.match(
    source,
    /authoritative_movement_hash_missing_post_migration/,
    'replay helper must reject missing movement hashes for post-migration rows'
  );

  assert.match(
    body,
    /inventoryEventVersionExists\([\s\S]*event\.aggregateType[\s\S]*event\.aggregateId[\s\S]*event\.eventType[\s\S]*event\.eventVersion/,
    'replay event repair must key event existence by aggregate identity, event type, and version'
  );
});

test('event registry validation stays wired into migrated mutation events', async () => {
  const [registrySource, appendSource] = await Promise.all([
    readFile(EVENT_REGISTRY_SOURCE, 'utf8'),
    readFile(EVENT_APPEND_SOURCE, 'utf8')
  ]);

  for (const registryEntry of [
    'inventoryMovementPosted',
    'inventoryReservationChanged',
    'inventoryTransferCreated',
    'inventoryTransferIssued',
    'inventoryTransferReceived',
    'inventoryTransferVoided',
    'licensePlateMoved',
    'workOrderIssuePosted',
    'workOrderCompletionPosted',
    'workOrderProductionReported',
    'workOrderProductionReversed',
    'workOrderWipValuationRecorded'
  ]) {
    assert.match(
      registrySource,
      new RegExp(`\\b${registryEntry}:`),
      `inventory event registry must define ${registryEntry}`
    );
  }

  assert.match(
    registrySource,
    /aggregateIdSource:\s*'inventory_transfer\.id'/,
    'transfer registry identities must declare their authoritative aggregate source'
  );
  assert.match(
    registrySource,
    /workOrderWipValuationRecorded:[\s\S]*aggregateIdPayloadKey:\s*'movementId'/,
    'WIP valuation registry identity must anchor on movementId so issue/report/reversal variants remain stable'
  );
  assert.match(
    registrySource,
    /aggregateIdSource:\s*'inventory_movements\.id'/,
    'registry entries must declare aggregateIdSource for movement-scoped events'
  );
  assert.match(
    registrySource,
    /aggregateIdSource:\s*'work_order_executions\.id'/,
    'registry entries must declare aggregateIdSource for work-order execution events'
  );
  assert.match(
    registrySource,
    /aggregateIdSource:\s*'license_plates\.id'/,
    'registry entries must declare aggregateIdSource for license-plate events'
  );
  assert.match(
    appendSource,
    /\bvalidateInventoryEventRegistryInput\(input\)/,
    'appendInventoryEvent must validate inputs against the central event registry'
  );
});

test('runInventoryCommand keeps authoritative event append before projection ops', async () => {
  const source = await readFile(WRAPPER_SOURCE, 'utf8');

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
