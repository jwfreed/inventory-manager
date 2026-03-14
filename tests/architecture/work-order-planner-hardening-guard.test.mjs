import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const WORK_ORDER_EXECUTION_SERVICE = path.resolve(
  process.cwd(),
  'src/services/workOrderExecution.service.ts'
);

test('work-order orchestrator no longer owns movement canonicalization or deterministic sorting', async () => {
  const source = await readFile(WORK_ORDER_EXECUTION_SERVICE, 'utf8');
  assert.doesNotMatch(
    source,
    /\bgetCanonicalMovementFields\b/,
    'workOrderExecution.service.ts must delegate canonical UOM derivation to inventoryMovementPlanner'
  );
  assert.doesNotMatch(
    source,
    /\bsortDeterministicMovementLines\(/,
    'workOrderExecution.service.ts must not sort authoritative movement lines after planning'
  );
});

test('inventoryMovementPlanner returns immutable movement plans', async () => {
  const { buildIssueMovement } = require('../../src/services/inventoryMovementPlanner.ts');

  const fakeClient = {
    async query(sql) {
      if (!/FROM items/i.test(sql)) {
        throw new Error(`Unexpected planner query: ${sql}`);
      }
      return {
        rowCount: 1,
        rows: [
          {
            uom_dimension: 'count',
            canonical_uom: 'each',
            stocking_uom: 'each'
          }
        ]
      };
    }
  };

  const plan = await buildIssueMovement({
    client: fakeClient,
    header: {
      id: 'movement-1',
      tenantId: 'tenant-1',
      movementType: 'issue',
      status: 'posted',
      externalRef: 'wo-issue:test',
      sourceType: 'work_order_issue_post',
      sourceId: 'issue-1',
      idempotencyKey: 'wo-issue-post:issue-1',
      occurredAt: '2026-03-01T00:00:00.000Z',
      postedAt: '2026-03-01T00:00:00.000Z',
      notes: null,
      metadata: null,
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z'
    },
    lines: [
      {
        sourceLineId: 'line-1',
        warehouseId: 'warehouse-1',
        itemId: 'item-1',
        locationId: 'location-1',
        quantity: -5,
        uom: 'each',
        defaultReasonCode: 'work_order_issue',
        lineNotes: 'line 1'
      }
    ]
  });

  assert.throws(() => {
    plan.sortedLines.push('mutate');
  }, TypeError);
  assert.throws(() => {
    plan.persistInput.lines[0].reasonCode = 'mutated';
  }, TypeError);
  assert.throws(() => {
    plan.sortedLines[0].canonicalFields.quantityDeltaCanonical = 99;
  }, TypeError);
});
