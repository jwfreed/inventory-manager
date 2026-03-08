import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const PUTAWAYS_SERVICE = path.resolve(process.cwd(), 'src/services/putaways.service.ts');
const TRANSFERS_SERVICE = path.resolve(process.cwd(), 'src/services/transfers.service.ts');
const QC_SERVICE = path.resolve(process.cwd(), 'src/services/qc.service.ts');
const INVENTORY_COMMAND_WRAPPER = path.resolve(process.cwd(), 'src/modules/platform/application/runInventoryCommand.ts');
const MUTATION_SUPPORT = path.resolve(process.cwd(), 'src/modules/platform/application/inventoryMutationSupport.ts');
const EVENT_REGISTRY = path.resolve(process.cwd(), 'src/modules/platform/application/inventoryEventRegistry.ts');

function extractFunctionBody(source, signaturePrefix, functionName) {
  const marker = `${signaturePrefix} ${functionName}`;
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `expected function marker: ${marker}`);

  const paramsOpenIndex = source.indexOf('(', markerIndex);
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

  const openBraceIndex = source.indexOf('{', paramsCloseIndex);
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

test('transfer-family orchestration must use the canonical mutation shell', async () => {
  const putawaysSource = await readFile(PUTAWAYS_SERVICE, 'utf8');
  const transfersSource = await readFile(TRANSFERS_SERVICE, 'utf8');
  const qcSource = await readFile(QC_SERVICE, 'utf8');

  const postPutawayBody = extractFunctionBody(putawaysSource, 'export async function', 'postPutaway');
  assert.match(postPutawayBody, /\brunInventoryCommand(?:<[^>]+>)?\(/, 'postPutaway must use runInventoryCommand()');
  assert.doesNotMatch(postPutawayBody, /\bwithTransaction(?:Retry)?\(/, 'postPutaway must not own a manual transaction shell');

  const postTransferBody = extractFunctionBody(transfersSource, 'export async function', 'postInventoryTransfer');
  assert.match(postTransferBody, /\btransferInventory\(/, 'postInventoryTransfer must use the migrated transfer shell');
  assert.doesNotMatch(postTransferBody, /\bwithTransactionRetry\(/, 'postInventoryTransfer must not own a manual retry shell');

  const transferInventoryBody = extractFunctionBody(transfersSource, 'export async function', 'transferInventory');
  assert.match(transferInventoryBody, /\brunInventoryCommand(?:<[^>]+>)?\(/, 'transferInventory must use runInventoryCommand() when it owns orchestration');

  const voidTransferBody = extractFunctionBody(transfersSource, 'export async function', 'voidTransferMovement');
  assert.match(voidTransferBody, /\brunInventoryCommand(?:<[^>]+>)?\(/, 'voidTransferMovement must use runInventoryCommand()');
  assert.doesNotMatch(voidTransferBody, /\bwithTransactionRetry\(/, 'voidTransferMovement must not own a manual retry shell');

  const qcDispositionBody = extractFunctionBody(qcSource, 'export async function', 'postQcWarehouseDisposition');
  assert.match(qcDispositionBody, /\btransferInventory\(/, 'QC warehouse disposition must use the migrated transfer shell');
  assert.doesNotMatch(qcDispositionBody, /\bwithTransactionRetry\(/, 'QC warehouse disposition must not own a manual retry shell');
});

test('transfer-family flows must not read derived projections for correctness', async () => {
  const putawaysSource = await readFile(PUTAWAYS_SERVICE, 'utf8');
  const transfersSource = await readFile(TRANSFERS_SERVICE, 'utf8');
  const qcSource = await readFile(QC_SERVICE, 'utf8');

  const bodies = [
    extractFunctionBody(putawaysSource, 'export async function', 'postPutaway'),
    extractFunctionBody(transfersSource, 'export async function', 'postInventoryTransfer'),
    extractFunctionBody(transfersSource, 'export async function', 'transferInventory'),
    extractFunctionBody(transfersSource, 'export async function', 'voidTransferMovement'),
    extractFunctionBody(qcSource, 'export async function', 'postQcWarehouseDisposition')
  ];

  for (const body of bodies) {
    assert.doesNotMatch(body, /\bgetInventoryBalance(?:ForUpdate)?\(/, 'transfer-family flows must not read inventory_balance for correctness');
    assert.doesNotMatch(body, /\bquantity_on_hand\b/, 'transfer-family flows must not read items.quantity_on_hand for correctness');
    assert.doesNotMatch(body, /\baverage_cost\b/, 'transfer-family flows must not read items.average_cost for correctness');
  }
});

test('authoritative events must append before compatibility projection ops', async () => {
  const wrapperSource = await readFile(INVENTORY_COMMAND_WRAPPER, 'utf8');
  const appendIndex = wrapperSource.indexOf('appendInventoryEventsWithDispatch(');
  const projectionIndex = wrapperSource.indexOf('for (const projectionOp of execution.projectionOps ?? [])');

  assert.notEqual(appendIndex, -1, 'runInventoryCommand must append authoritative events');
  assert.notEqual(projectionIndex, -1, 'runInventoryCommand must execute projection ops');
  assert.ok(appendIndex < projectionIndex, 'authoritative event append must precede projection ops');
});

test('movement events must preserve stable aggregate identity', async () => {
  const [helperSource, registrySource] = await Promise.all([
    readFile(MUTATION_SUPPORT, 'utf8'),
    readFile(EVENT_REGISTRY, 'utf8')
  ]);
  assert.match(
    helperSource,
    /buildInventoryRegistryEvent\('inventoryMovementPosted'/,
    'movement posted events must route through the central registry'
  );
  assert.match(
    registrySource,
    /inventoryMovementPosted:[\s\S]*aggregateIdPayloadKey:\s*'movementId'/,
    'movement registry identity must anchor on stable movementId aggregate ids'
  );
});

test('transfer replay hardening requires deterministic line plans and transfer registry events', async () => {
  const [transfersSource, helperSource, registrySource] = await Promise.all([
    readFile(TRANSFERS_SERVICE, 'utf8'),
    readFile(MUTATION_SUPPORT, 'utf8'),
    readFile(EVENT_REGISTRY, 'utf8')
  ]);

  const buildPlanBody = extractFunctionBody(transfersSource, 'async function', 'buildTransferMovementPlan');
  assert.match(
    buildPlanBody,
    /\bsortDeterministicMovementLines\(/,
    'transfer movement planning must sort authoritative movement lines deterministically'
  );
  assert.match(
    buildPlanBody,
    /\bbuildMovementDeterministicHash\(/,
    'transfer movement planning must compute deterministic movement hashes'
  );

  for (const functionName of ['executeTransferInventoryWrapperMutation', 'voidTransferMovement']) {
    const body = extractFunctionBody(
      transfersSource,
      functionName === 'voidTransferMovement' ? 'export async function' : 'async function',
      functionName
    );
    assert.match(
      body,
      /\bbuildPostedDocumentReplayResult\(|\bbuildTransferReplayResult\(/,
      `${functionName} must delegate replay repair to the shared corruption-aware helper`
    );
  }

  assert.match(
    transfersSource,
    /\bbuildPostedDocumentReplayResult\(/,
    'transfer replay must delegate to the shared posted-document replay helper'
  );
  assert.match(
    helperSource,
    /REPLAY_CORRUPTION_DETECTED/,
    'shared replay hardening must fail closed with REPLAY_CORRUPTION_DETECTED'
  );
  for (const registryEntry of [
    'inventoryTransferCreated',
    'inventoryTransferIssued',
    'inventoryTransferReceived',
    'inventoryTransferVoided'
  ]) {
    assert.match(
      registrySource,
      new RegExp(`\\b${registryEntry}:`),
      `inventory event registry must define ${registryEntry}`
    );
  }
});

test('internal relocation lock scope must include both movement sides', async () => {
  const putawaysSource = await readFile(PUTAWAYS_SERVICE, 'utf8');
  const transfersSource = await readFile(TRANSFERS_SERVICE, 'utf8');

  const postPutawayBody = extractFunctionBody(putawaysSource, 'export async function', 'postPutaway');
  assert.match(
    postPutawayBody,
    /resolveWarehouseIdForLocation\(tenantId,\s*line\.from_location_id,\s*client\)/,
    'putaway lock scope must include the source location warehouse'
  );
  assert.match(
    postPutawayBody,
    /resolveWarehouseIdForLocation\(tenantId,\s*line\.to_location_id,\s*client\)/,
    'putaway lock scope must include the destination location warehouse'
  );

  assert.match(
    transfersSource,
    /buildTransferLockTargets[\s\S]*sourceWarehouseId[\s\S]*destinationWarehouseId/,
    'transfer lock scope must include both source and destination warehouse targets'
  );
});
