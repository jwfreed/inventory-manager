import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { assertMovementContract } from './helpers/mutationContract.mjs';

const AUTHORITATIVE_BATCH_SOURCE_TYPES = [
  'work_order_batch_post_completion',
  'work_order_batch_post_issue'
];

function semanticResult(result) {
  return {
    workOrderId: result.workOrderId,
    productionReportId: result.productionReportId,
    componentIssueMovementId: result.componentIssueMovementId,
    productionReceiptMovementId: result.productionReceiptMovementId,
    idempotencyKey: result.idempotencyKey,
    lotTracking: result.lotTracking
  };
}

async function createProductionFixture(prefix, quantity) {
  const harness = await createServiceHarness({
    tenantPrefix: prefix,
    tenantName: `Contract ${prefix}`
  });
  const { topology } = harness;
  const component = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: `${prefix}-RAW`,
    type: 'raw'
  });
  const output = await harness.createItem({
    defaultLocationId: topology.defaults.QA.id,
    skuPrefix: `${prefix}-FG`,
    type: 'finished'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: component.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity,
    unitCost: 4
  });
  const bom = await harness.createBomAndActivate({
    outputItemId: output.id,
    components: [{ componentItemId: component.id, quantityPer: 1 }],
    suffix: randomUUID().slice(0, 6)
  });
  const workOrder = await harness.createWorkOrder({
    kind: 'production',
    outputItemId: output.id,
    outputUom: 'each',
    quantityPlanned: quantity,
    bomId: bom.id,
    defaultConsumeLocationId: topology.defaults.SELLABLE.id,
    defaultProduceLocationId: topology.defaults.QA.id
  });

  return { harness, component, output, workOrder };
}

async function snapshotReportState(db, tenantId, workOrderId, idempotencyKey) {
  const executionResult = await db.query(
    `SELECT id,
            status,
            consumption_movement_id AS "issueMovementId",
            production_movement_id AS "receiveMovementId",
            output_lot_id AS "outputLotId",
            production_batch_id AS "productionBatchId",
            idempotency_key AS "idempotencyKey"
       FROM work_order_executions
      WHERE tenant_id = $1
        AND work_order_id = $2
        AND idempotency_key = $3
      ORDER BY created_at ASC, id ASC`,
    [tenantId, workOrderId, idempotencyKey]
  );
  const executions = executionResult.rows;
  const executionIds = executions.map((row) => row.id);

  const issueDocumentResult = await db.query(
    `SELECT id,
            inventory_movement_id AS "inventoryMovementId",
            idempotency_key AS "idempotencyKey"
       FROM work_order_material_issues
      WHERE tenant_id = $1
        AND idempotency_key = $2
      ORDER BY created_at ASC, id ASC`,
    [tenantId, `${idempotencyKey}:issue-doc`]
  );

  const movementResult = executionIds.length > 0
    ? await db.query(
        `SELECT id,
                movement_type AS "movementType",
                source_type AS "sourceType",
                source_id AS "sourceId",
                idempotency_key AS "idempotencyKey",
                lot_id AS "lotId",
                production_batch_id AS "productionBatchId"
           FROM inventory_movements
          WHERE tenant_id = $1
            AND source_id = ANY($2::text[])
            AND source_type = ANY($3::text[])
          ORDER BY source_type ASC, id ASC`,
        [tenantId, executionIds, AUTHORITATIVE_BATCH_SOURCE_TYPES]
      )
    : { rows: [] };
  const movementIds = movementResult.rows.map((row) => row.id);

  const movementLotResult = movementIds.length > 0
    ? await db.query(
        `SELECT iml.movement_id AS "movementId",
                imlot.inventory_movement_line_id AS "movementLineId",
                imlot.lot_id AS "lotId",
                imlot.uom,
                imlot.quantity_delta::numeric AS "quantityDelta"
           FROM inventory_movement_lots imlot
           JOIN inventory_movement_lines iml
             ON iml.id = imlot.inventory_movement_line_id
            AND iml.tenant_id = imlot.tenant_id
          WHERE imlot.tenant_id = $1
            AND iml.movement_id = ANY($2::uuid[])
          ORDER BY iml.movement_id ASC, imlot.inventory_movement_line_id ASC, imlot.lot_id ASC`,
        [tenantId, movementIds]
      )
    : { rows: [] };

  const lotLinkResult = executionIds.length > 0
    ? await db.query(
        `SELECT work_order_execution_id AS "executionId",
                role,
                item_id AS "itemId",
                lot_id AS "lotId",
                uom,
                quantity::numeric AS quantity
           FROM work_order_lot_links
          WHERE tenant_id = $1
            AND work_order_execution_id = ANY($2::uuid[])
          ORDER BY work_order_execution_id ASC, role ASC, item_id ASC, lot_id ASC, uom ASC`,
        [tenantId, executionIds]
      )
    : { rows: [] };

  const idempotencyResult = await db.query(
    `SELECT key,
            endpoint,
            status,
            response_status AS "responseStatus"
       FROM idempotency_keys
      WHERE tenant_id = $1
        AND key = $2
      ORDER BY key ASC`,
    [tenantId, idempotencyKey]
  );

  return {
    executions,
    issueDocuments: issueDocumentResult.rows,
    movements: movementResult.rows,
    movementLots: movementLotResult.rows.map((row) => ({
      ...row,
      quantityDelta: Number(row.quantityDelta)
    })),
    lotLinks: lotLinkResult.rows.map((row) => ({
      ...row,
      quantity: Number(row.quantity)
    })),
    idempotencyRows: idempotencyResult.rows
  };
}

function assertSingleAuthoritativePosting(state) {
  assert.equal(state.executions.length, 1, 'same key must create one work-order execution');
  assert.equal(state.issueDocuments.length, 1, 'same key must create one material issue document');
  assert.equal(state.movements.length, 2, 'same key must create exactly one issue/receive movement pair');
  assert.deepEqual(
    state.movements.map((row) => row.sourceType),
    AUTHORITATIVE_BATCH_SOURCE_TYPES
  );
  assert.equal(state.idempotencyRows.length, 1, 'same key must have one idempotency claim');

  const execution = state.executions[0];
  assert.equal(execution.status, 'posted');
  assert.ok(execution.issueMovementId, 'execution must keep issue movement link');
  assert.ok(execution.receiveMovementId, 'execution must keep receive movement link');
  for (const movement of state.movements) {
    assert.equal(movement.sourceId, execution.id);
  }
}

function movementBySourceType(state, sourceType) {
  const movement = state.movements.find((row) => row.sourceType === sourceType);
  assert.ok(movement, `missing movement source type ${sourceType}`);
  return movement;
}

test('WF-6 report-production same idempotency key replays stable result and authoritative write set', async () => {
  const { harness, component, output, workOrder } = await createProductionFixture(
    'contract-wf6-replay',
    3
  );
  const { tenantId, pool: db, topology } = harness;
  const idempotencyKey = `contract-wf6-replay:${randomUUID()}`;
  const requestBody = {
    warehouseId: topology.warehouse.id,
    outputQty: 3,
    outputUom: 'each',
    occurredAt: '2026-03-04T00:00:00.000Z'
  };

  const first = await harness.reportProduction(
    workOrder.id,
    requestBody,
    {},
    { idempotencyKey }
  );
  assert.equal(first.replayed, false);
  const firstState = await snapshotReportState(db, tenantId, workOrder.id, idempotencyKey);
  assertSingleAuthoritativePosting(firstState);
  assert.equal(firstState.lotLinks.length, 1, 'successful TX-2 must append one produce lot link');
  assert.equal(firstState.movementLots.length, 1, 'successful TX-2 must append one receipt movement lot row');

  const replay = await harness.reportProduction(
    workOrder.id,
    requestBody,
    {},
    { idempotencyKey }
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(semanticResult(replay), semanticResult(first));
  assert.equal(replay.lotTracking.outputLotId, firstState.executions[0].outputLotId);

  const replayState = await snapshotReportState(db, tenantId, workOrder.id, idempotencyKey);
  assert.deepEqual(replayState, firstState, 'replay must not create net-new authoritative or traceability rows');

  await assertMovementContract({
    harness,
    movementId: first.componentIssueMovementId,
    expectedMovementType: 'issue',
    expectedSourceType: 'work_order_batch_post_issue',
    expectedLineCount: 1,
    expectedBalances: [{ itemId: component.id, locationId: topology.defaults.SELLABLE.id, onHand: 0 }]
  });
  await assertMovementContract({
    harness,
    movementId: first.productionReceiptMovementId,
    expectedMovementType: 'receive',
    expectedSourceType: 'work_order_batch_post_completion',
    expectedLineCount: 1,
    expectedBalances: [{ itemId: output.id, locationId: topology.defaults.QA.id, onHand: 3 }]
  });
});

test('WF-6 report-production same idempotency key concurrent calls converge on one authoritative write set', async () => {
  const { harness, workOrder } = await createProductionFixture(
    'contract-wf6-concurrent',
    5
  );
  const { tenantId, pool: db, topology } = harness;
  const idempotencyKey = `contract-wf6-concurrent:${randomUUID()}`;
  const requestBody = {
    warehouseId: topology.warehouse.id,
    outputQty: 5,
    outputUom: 'each',
    occurredAt: '2026-03-06T00:00:00.000Z'
  };

  const outcomes = await harness.runConcurrently([
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.reportProduction(workOrder.id, requestBody, {}, { idempotencyKey });
    },
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.reportProduction(workOrder.id, requestBody, {}, { idempotencyKey });
    }
  ]);

  const rejected = outcomes
    .filter((outcome) => outcome.status === 'rejected')
    .map((outcome) => ({
      code: outcome.reason?.code ?? null,
      message: outcome.reason?.message ?? null,
      details: outcome.reason?.details ?? null
    }));
  assert.equal(rejected.length, 0, `same-key concurrent calls must converge, got ${JSON.stringify(rejected)}`);

  const [first, second] = outcomes.map((outcome) => outcome.value);
  assert.deepEqual(semanticResult(second), semanticResult(first));
  assert.deepEqual(
    new Set([first.replayed, second.replayed]),
    new Set([false, true]),
    'one concurrent call must post and the other must replay'
  );

  const concurrentState = await snapshotReportState(db, tenantId, workOrder.id, idempotencyKey);
  assertSingleAuthoritativePosting(concurrentState);
  assert.equal(concurrentState.lotLinks.length, 1, 'concurrent TX-2 finalization must create one produce lot link');
  assert.equal(concurrentState.movementLots.length, 1, 'concurrent TX-2 finalization must create one movement lot row');

  const execution = concurrentState.executions[0];
  const issueMovement = movementBySourceType(concurrentState, 'work_order_batch_post_issue');
  const receiptMovement = movementBySourceType(concurrentState, 'work_order_batch_post_completion');
  assert.equal(first.productionReportId, execution.id);
  assert.equal(first.componentIssueMovementId, issueMovement.id);
  assert.equal(first.productionReceiptMovementId, receiptMovement.id);
  assert.equal(execution.issueMovementId, issueMovement.id);
  assert.equal(execution.receiveMovementId, receiptMovement.id);
  assert.equal(first.lotTracking.outputLotId, concurrentState.lotLinks[0].lotId);
  assert.equal(first.lotTracking.outputLotId, concurrentState.movementLots[0].lotId);
  assert.equal(first.lotTracking.inputLotCount, 0);

  const replay = await harness.reportProduction(
    workOrder.id,
    requestBody,
    {},
    { idempotencyKey }
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(semanticResult(replay), semanticResult(first));

  const replayState = await snapshotReportState(db, tenantId, workOrder.id, idempotencyKey);
  assert.deepEqual(replayState, concurrentState, 'post-concurrency replay must not create new authoritative or traceability rows');
});

test('WF-6 report-production recovers TX-2 lot-link failure without duplicate authoritative writes', async () => {
  const { harness, workOrder } = await createProductionFixture(
    'contract-wf6-recovery',
    4
  );
  const { tenantId, pool: db, topology } = harness;
  const idempotencyKey = `contract-wf6-recovery:${randomUUID()}:simulate-lot-link-failure`;
  const requestBody = {
    warehouseId: topology.warehouse.id,
    outputQty: 4,
    outputUom: 'each',
    occurredAt: '2026-03-05T00:00:00.000Z'
  };

  await assert.rejects(
    () => harness.reportProduction(workOrder.id, requestBody, {}, { idempotencyKey }),
    (error) => {
      assert.equal(error.code, 'WO_REPORT_LOT_LINK_INCOMPLETE');
      assert.equal(error.details?.reason, 'simulated_failure_after_post_before_lot_link');
      assert.ok(error.details?.productionReportId);
      return true;
    }
  );

  const partialState = await snapshotReportState(db, tenantId, workOrder.id, idempotencyKey);
  assertSingleAuthoritativePosting(partialState);
  assert.equal(partialState.lotLinks.length, 0, 'TX-2 failure must leave lot links incomplete');
  assert.equal(partialState.movementLots.length, 0, 'TX-2 failure must leave movement lot links incomplete');

  const partialExecution = partialState.executions[0];
  const partialIssue = movementBySourceType(partialState, 'work_order_batch_post_issue');
  const partialReceipt = movementBySourceType(partialState, 'work_order_batch_post_completion');
  assert.equal(partialIssue.id, partialExecution.issueMovementId);
  assert.equal(partialReceipt.id, partialExecution.receiveMovementId);

  const recovered = await harness.reportProduction(
    workOrder.id,
    requestBody,
    {},
    { idempotencyKey }
  );
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.productionReportId, partialExecution.id);
  assert.equal(recovered.componentIssueMovementId, partialIssue.id);
  assert.equal(recovered.productionReceiptMovementId, partialReceipt.id);
  assert.equal(recovered.lotTracking.outputLotId, partialExecution.outputLotId);
  assert.equal(recovered.lotTracking.inputLotCount, 0);

  const recoveredState = await snapshotReportState(db, tenantId, workOrder.id, idempotencyKey);
  assertSingleAuthoritativePosting(recoveredState);
  assert.equal(recoveredState.lotLinks.length, 1, 'retry must complete produce lot link exactly once');
  assert.equal(recoveredState.movementLots.length, 1, 'retry must complete receipt movement lot exactly once');
  assert.equal(recoveredState.lotLinks[0].lotId, recovered.lotTracking.outputLotId);
  assert.equal(recoveredState.movementLots[0].lotId, recovered.lotTracking.outputLotId);

  const replayAfterRecovery = await harness.reportProduction(
    workOrder.id,
    requestBody,
    {},
    { idempotencyKey }
  );
  assert.equal(replayAfterRecovery.replayed, true);
  assert.deepEqual(semanticResult(replayAfterRecovery), semanticResult(recovered));

  const replayState = await snapshotReportState(db, tenantId, workOrder.id, idempotencyKey);
  assert.deepEqual(replayState, recoveredState, 'post-recovery replay must not create net-new state');
});
