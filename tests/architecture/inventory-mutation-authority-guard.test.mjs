import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const SRC_ROOT = path.resolve(process.cwd(), 'src');
const LEDGER_WRITER = path.resolve(process.cwd(), 'src/domains/inventory/internal/ledgerWriter.ts');
const INVENTORY_DOMAIN_INDEX = path.resolve(process.cwd(), 'src/domains/inventory/index.ts');
const INVENTORY_EVENTS = path.resolve(
  process.cwd(),
  'src/modules/platform/infrastructure/inventoryEvents.ts'
);
const EVENT_REGISTRY = path.resolve(
  process.cwd(),
  'src/modules/platform/application/inventoryEventRegistry.ts'
);
const INVENTORY_COMMAND_WRAPPER = path.resolve(
  process.cwd(),
  'src/modules/platform/application/runInventoryCommand.ts'
);
const RECEIPTS_SERVICE = path.resolve(process.cwd(), 'src/services/receipts.service.ts');
const PUTAWAYS_SERVICE = path.resolve(process.cwd(), 'src/services/putaways.service.ts');
const ORDER_TO_CASH_SERVICE = path.resolve(process.cwd(), 'src/services/orderToCash.service.ts');
const TRANSFERS_SERVICE = path.resolve(process.cwd(), 'src/services/transfers.service.ts');
const LICENSE_PLATES_SERVICE = path.resolve(process.cwd(), 'src/services/licensePlates.service.ts');
const COUNTS_SERVICE = path.resolve(process.cwd(), 'src/services/counts.service.ts');
const ADJUSTMENTS_SERVICE = path.resolve(process.cwd(), 'src/services/adjustments/posting.service.ts');
const QC_SERVICE = path.resolve(process.cwd(), 'src/services/qc.service.ts');
const WORK_ORDER_EXECUTION_SERVICE = path.resolve(
  process.cwd(),
  'src/services/workOrderExecution.service.ts'
);
const { INVENTORY_EVENT_REGISTRY } = require('../../src/modules/platform/application/inventoryEventRegistry.ts');

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
  for (let index = paramsOpenIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        paramsCloseIndex = index;
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

  for (let index = paramsCloseIndex + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === ':' && !inReturnType && !lastNonWhitespaceChar) {
      inReturnType = true;
      lastNonWhitespaceChar = char;
      continue;
    }
    if (!inReturnType && /\s/.test(char)) {
      continue;
    }
    if (!inReturnType && char === '{') {
      openBraceIndex = index;
      break;
    }
    if (inReturnType) {
      if (char === '<') {
        angleDepth += 1;
      } else if (char === '>') {
        angleDepth = Math.max(0, angleDepth - 1);
      } else if (char === '{') {
        if (angleDepth === 0 && typeBraceDepth === 0 && lastNonWhitespaceChar !== ':') {
          openBraceIndex = index;
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
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBraceIndex + 1, index);
      }
    }
  }

  throw new Error(`failed to parse function body for ${functionName}`);
}

async function collectSourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'migrations') {
        continue;
      }
      files.push(...await collectSourceFiles(resolved));
      continue;
    }
    if (entry.isFile() && resolved.endsWith('.ts')) {
      files.push(resolved);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

test('production source keeps authoritative inventory writes inside canonical infrastructure', async () => {
  const files = await collectSourceFiles(SRC_ROOT);
  const violations = [];

  const writeChecks = [
    {
      label: 'inventory_movements',
      pattern: /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+inventory_movements\b/,
      allowed: new Set([LEDGER_WRITER])
    },
    {
      label: 'inventory_movement_lines',
      pattern: /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+inventory_movement_lines\b/,
      allowed: new Set([LEDGER_WRITER])
    },
    {
      label: 'inventory_events',
      pattern: /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+inventory_events\b/,
      allowed: new Set([INVENTORY_EVENTS])
    }
  ];

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    for (const check of writeChecks) {
      if (check.pattern.test(source) && !check.allowed.has(filePath)) {
        violations.push(`${path.relative(process.cwd(), filePath)} => ${check.label}`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `unexpected authoritative inventory writes outside canonical infrastructure:\n${violations.join('\n')}`
  );
});

test('production source only uses the canonical movement writer helper', async () => {
  const files = await collectSourceFiles(SRC_ROOT);
  const violations = [];

  for (const filePath of files) {
    if (filePath === LEDGER_WRITER) {
      continue;
    }
    const source = await readFile(filePath, 'utf8');
    if (/\bcreateInventoryMovement(?:Line)?\(/.test(source)) {
      violations.push(path.relative(process.cwd(), filePath));
    }
  }

  assert.deepEqual(
    violations,
    [],
    `unexpected direct movement-writer primitive usage outside ledgerWriter:\n${violations.join('\n')}`
  );
});

test('inventory domain surface does not re-export low-level movement writer primitives', async () => {
  const source = await readFile(INVENTORY_DOMAIN_INDEX, 'utf8');
  assert.doesNotMatch(
    source,
    /\bcreateInventoryMovement(?:Line|Lines)?\b/,
    'inventory domain barrel must not expose low-level movement writer primitives'
  );
});

test('production source only appends authoritative inventory events through canonical infrastructure', async () => {
  const files = await collectSourceFiles(SRC_ROOT);
  const violations = [];

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    if (
      /\bappendInventoryEvent(?:sWithDispatch|WithDispatch)?\(/.test(source)
      && !new Set([INVENTORY_EVENTS, INVENTORY_COMMAND_WRAPPER]).has(filePath)
    ) {
      violations.push(path.relative(process.cwd(), filePath));
    }
  }

  assert.deepEqual(
    violations,
    [],
    `unexpected authoritative inventory event append usage outside canonical infrastructure:\n${violations.join('\n')}`
  );
});

test('movement-backed mutation entrypoints stay wrapper-managed', async () => {
  const nodes = [
    [RECEIPTS_SERVICE, 'createPurchaseOrderReceipt'],
    [RECEIPTS_SERVICE, 'voidReceipt'],
    [PUTAWAYS_SERVICE, 'postPutaway'],
    [ORDER_TO_CASH_SERVICE, 'postShipment'],
    [TRANSFERS_SERVICE, 'transferInventory'],
    [TRANSFERS_SERVICE, 'voidTransferMovement'],
    [LICENSE_PLATES_SERVICE, 'moveLicensePlate'],
    [COUNTS_SERVICE, 'postInventoryCount'],
    [ADJUSTMENTS_SERVICE, 'postInventoryAdjustment'],
    [QC_SERVICE, 'createQcEvent'],
    [WORK_ORDER_EXECUTION_SERVICE, 'postWorkOrderIssue'],
    [WORK_ORDER_EXECUTION_SERVICE, 'postWorkOrderCompletion'],
    [WORK_ORDER_EXECUTION_SERVICE, 'recordWorkOrderBatch'],
    [WORK_ORDER_EXECUTION_SERVICE, 'voidWorkOrderProductionReport']
  ];

  const uniqueFiles = [...new Set(nodes.map(([filePath]) => filePath))];
  const sources = new Map(
    await Promise.all(uniqueFiles.map(async (filePath) => [filePath, await readFile(filePath, 'utf8')]))
  );

  for (const [filePath, functionName] of nodes) {
    const body = extractFunctionBody(sources.get(filePath), functionName);
    assert.match(
      body,
      /\brunInventoryCommand(?:<[^>]+>)?\(/,
      `${functionName} must use runInventoryCommand()`
    );
  }
});

test('inventory registry covers every authoritative event builder and defines aggregate identity inputs', async () => {
  const files = await collectSourceFiles(SRC_ROOT);
  const usedRegistryNames = new Set();

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    for (const match of source.matchAll(/buildInventoryRegistryEvent\('([^']+)'/g)) {
      usedRegistryNames.add(match[1]);
    }
  }

  for (const name of usedRegistryNames) {
    assert.ok(
      Object.hasOwn(INVENTORY_EVENT_REGISTRY, name),
      `missing inventory event registry entry for ${name}`
    );
    const definition = INVENTORY_EVENT_REGISTRY[name];
    assert.ok(
      typeof definition.aggregateIdSource === 'string' && definition.aggregateIdSource.trim(),
      `inventory event registry entry ${name} must declare aggregateIdSource`
    );
    assert.ok(
      typeof definition.aggregateIdPayloadKey === 'string' && definition.aggregateIdPayloadKey.trim(),
      `inventory event registry entry ${name} must declare aggregateIdPayloadKey`
    );
  }

  const registrySource = await readFile(EVENT_REGISTRY, 'utf8');
  assert.match(
    registrySource,
    /aggregateId:\s*resolveAggregateIdFromPayload\(params\.payload, definition\.aggregateIdPayloadKey\)/,
    'buildInventoryRegistryEvent must derive aggregate ids from the registry payload key'
  );
});
