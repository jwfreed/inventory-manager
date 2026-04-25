import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from './helpers/service-harness.mjs';

async function createProductionFixture(label, componentLayers) {
  const harness = await createServiceHarness({
    tenantPrefix: label,
    tenantName: `Work Order ${label}`
  });
  const { topology } = harness;
  const component = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: `${label}-COMP`,
    type: 'raw'
  });
  const output = await harness.createItem({
    defaultLocationId: topology.defaults.QA.id,
    skuPrefix: `${label}-FG`,
    type: 'finished'
  });

  let runningQuantity = 0;
  for (const layer of componentLayers) {
    runningQuantity += layer.quantity;
    await harness.seedStockViaCount({
      warehouseId: topology.warehouse.id,
      itemId: component.id,
      locationId: topology.defaults.SELLABLE.id,
      quantity: runningQuantity,
      unitCost: layer.unitCost
    });
  }

  const bom = await harness.createBomAndActivate({
    outputItemId: output.id,
    components: [
      {
        componentItemId: component.id,
        quantityPer: 1
      }
    ],
    suffix: label
  });

  const workOrder = await harness.createWorkOrder({
    kind: 'production',
    outputItemId: output.id,
    outputUom: 'each',
    quantityPlanned: runningQuantity,
    bomId: bom.id,
    defaultConsumeLocationId: topology.defaults.SELLABLE.id,
    defaultProduceLocationId: topology.defaults.QA.id
  });

  return {
    harness,
    componentItemId: component.id,
    outputItemId: output.id,
    workOrderId: workOrder.id
  };
}

async function loadExecutionConservation(db, tenantId, productionMovementId) {
  const executionResult = await db.query(
    `SELECT id
       FROM work_order_executions
      WHERE tenant_id = $1
        AND production_movement_id = $2`,
    [tenantId, productionMovementId]
  );
  assert.equal(executionResult.rowCount, 1);
  const executionId = executionResult.rows[0].id;

  const componentResult = await db.query(
    `SELECT COALESCE(SUM(extended_cost), 0)::numeric AS total_component_cost
       FROM cost_layer_consumptions
      WHERE tenant_id = $1
        AND wip_execution_id = $2
        AND consumption_type = 'production_input'`,
    [tenantId, executionId]
  );

  const movementResult = await db.query(
    `SELECT
        COALESCE(
          SUM(
            CASE
              WHEN COALESCE(quantity_delta_canonical, quantity_delta) > 0
               AND lower(COALESCE(reason_code, '')) NOT IN ('scrap', 'work_order_scrap', 'reject', 'work_order_reject')
              THEN COALESCE(
                extended_cost,
                COALESCE(quantity_delta_canonical, quantity_delta) * COALESCE(unit_cost, 0)
              )
              ELSE 0
            END
          ),
          0
        )::numeric AS total_fg_cost,
        COALESCE(
          SUM(
            CASE
              WHEN COALESCE(quantity_delta_canonical, quantity_delta) > 0
               AND lower(COALESCE(reason_code, '')) IN ('scrap', 'work_order_scrap', 'reject', 'work_order_reject')
              THEN COALESCE(
                extended_cost,
                COALESCE(quantity_delta_canonical, quantity_delta) * COALESCE(unit_cost, 0)
              )
              ELSE 0
            END
          ),
          0
        )::numeric AS scrap_cost
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2`,
    [tenantId, productionMovementId]
  );

  const componentCost = Number(componentResult.rows[0].total_component_cost);
  const fgCost = Number(movementResult.rows[0].total_fg_cost);
  const scrapCost = Number(movementResult.rows[0].scrap_cost);
  return {
    executionId,
    componentCost,
    fgCost,
    scrapCost,
    difference: componentCost - fgCost - scrapCost
  };
}

async function loadWorkOrderCostDriftCount(db, tenantId) {
  const driftResult = await db.query(
    `WITH posted_executions AS (
       SELECT e.id, e.tenant_id, e.production_movement_id
         FROM work_order_executions e
        WHERE e.tenant_id = $1
          AND e.status = 'posted'
          AND e.production_movement_id IS NOT NULL
     ),
     component_cost AS (
       SELECT clc.wip_execution_id,
              COALESCE(SUM(clc.extended_cost), 0)::numeric AS total_component_cost
         FROM cost_layer_consumptions clc
         JOIN posted_executions pe
           ON pe.id = clc.wip_execution_id
          AND pe.tenant_id = clc.tenant_id
        WHERE clc.consumption_type = 'production_input'
        GROUP BY clc.wip_execution_id
     ),
     movement_cost AS (
       SELECT iml.movement_id,
              COALESCE(
                SUM(
                  CASE
                    WHEN COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
                     AND lower(COALESCE(iml.reason_code, '')) NOT IN ('scrap', 'work_order_scrap', 'reject', 'work_order_reject')
                    THEN COALESCE(
                      iml.extended_cost,
                      COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) * COALESCE(iml.unit_cost, 0)
                    )
                    ELSE 0
                  END
                ),
                0
              )::numeric AS total_fg_cost,
              COALESCE(
                SUM(
                  CASE
                    WHEN COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
                     AND lower(COALESCE(iml.reason_code, '')) IN ('scrap', 'work_order_scrap', 'reject', 'work_order_reject')
                    THEN COALESCE(
                      iml.extended_cost,
                      COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) * COALESCE(iml.unit_cost, 0)
                    )
                    ELSE 0
                  END
                ),
                0
              )::numeric AS scrap_cost
         FROM inventory_movement_lines iml
         JOIN posted_executions pe
           ON pe.production_movement_id = iml.movement_id
          AND pe.tenant_id = iml.tenant_id
        GROUP BY iml.movement_id
     ),
     combined AS (
       SELECT pe.id AS work_order_execution_id,
              COALESCE(cc.total_component_cost, 0)::numeric AS total_component_cost,
              COALESCE(mc.total_fg_cost, 0)::numeric AS total_fg_cost,
              COALESCE(mc.scrap_cost, 0)::numeric AS scrap_cost,
              (
                COALESCE(cc.total_component_cost, 0)
                - COALESCE(mc.total_fg_cost, 0)
                - COALESCE(mc.scrap_cost, 0)
              )::numeric AS difference
         FROM posted_executions pe
         LEFT JOIN component_cost cc
           ON cc.wip_execution_id = pe.id
         LEFT JOIN movement_cost mc
           ON mc.movement_id = pe.production_movement_id
     )
     SELECT COUNT(*)::int AS count
       FROM combined
      WHERE ABS(difference) > 0.000001`,
    [tenantId]
  );
  return Number(driftResult.rows[0]?.count ?? 0);
}

async function expectServiceError(action, expectedCode) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.code ?? error?.message, expectedCode);
    return true;
  });
}

test('partial production across multiple reports preserves deterministic FIFO valuation', async () => {
  const { harness, workOrderId } = await createProductionFixture('wo-partial', [
    { quantity: 4, unitCost: 4 },
    { quantity: 3, unitCost: 6 }
  ]);
  const { tenantId, pool: db, topology } = harness;

  const reportA = await harness.reportProduction(
    workOrderId,
    {
      warehouseId: topology.warehouse.id,
      outputQty: 4,
      outputUom: 'each',
      occurredAt: '2026-02-20T00:00:00.000Z'
    },
    {},
    {
      idempotencyKey: `wo-report-a-${randomUUID()}`
    }
  );
  const reportB = await harness.reportProduction(
    workOrderId,
    {
      warehouseId: topology.warehouse.id,
      outputQty: 3,
      outputUom: 'each',
      occurredAt: '2026-02-21T00:00:00.000Z'
    },
    {},
    {
      idempotencyKey: `wo-report-b-${randomUUID()}`
    }
  );

  const conservationA = await loadExecutionConservation(db, tenantId, reportA.productionReceiptMovementId);
  const conservationB = await loadExecutionConservation(db, tenantId, reportB.productionReceiptMovementId);
  assert.ok(Math.abs(conservationA.componentCost - 16) < 1e-6);
  assert.ok(Math.abs(conservationA.fgCost - 16) < 1e-6);
  assert.ok(Math.abs(conservationA.difference) < 1e-6);
  assert.ok(Math.abs(conservationB.componentCost - 18) < 1e-6);
  assert.ok(Math.abs(conservationB.fgCost - 18) < 1e-6);
  assert.ok(Math.abs(conservationB.difference) < 1e-6);

  const driftCount = await loadWorkOrderCostDriftCount(db, tenantId);
  assert.equal(driftCount, 0);
});

test('record-batch idempotency replay stays deterministic and does not double-post inventory or cost', async () => {
  const { harness, componentItemId, outputItemId, workOrderId } = await createProductionFixture('wo-batch-idem', [
    { quantity: 6, unitCost: 5 }
  ]);
  const { tenantId, pool: db, topology } = harness;
  const idempotencyKey = `wo-batch-idem-${randomUUID()}`;
  const requestBody = {
    occurredAt: '2026-02-22T00:00:00.000Z',
    consumeLines: [
      {
        componentItemId,
        fromLocationId: topology.defaults.SELLABLE.id,
        uom: 'each',
        quantity: 6
      }
    ],
    produceLines: [
      {
        outputItemId,
        toLocationId: topology.defaults.QA.id,
        uom: 'each',
        quantity: 6
      }
    ]
  };

  const first = await harness.recordBatch(
    workOrderId,
    requestBody,
    {},
    { idempotencyKey }
  );
  const replay = await harness.recordBatch(
    workOrderId,
    requestBody,
    {},
    { idempotencyKey }
  );

  assert.equal(first.issueMovementId, replay.issueMovementId);
  assert.equal(first.receiveMovementId, replay.receiveMovementId);
  assert.equal(replay.replayed, true);

  const executionResult = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM work_order_executions
      WHERE tenant_id = $1
        AND idempotency_key = $2`,
    [tenantId, idempotencyKey]
  );
  assert.equal(Number(executionResult.rows[0]?.count ?? 0), 1);

  const movementResult = await db.query(
    `SELECT id, movement_deterministic_hash
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])
      ORDER BY id ASC`,
    [tenantId, [first.issueMovementId, first.receiveMovementId]]
  );
  assert.equal(movementResult.rowCount, 2);
  for (const row of movementResult.rows) {
    assert.ok(row.movement_deterministic_hash, `missing deterministic hash for ${row.id}`);
  }
});

test('record-batch replay fails closed when authoritative movement lines drift', async () => {
  const { harness, componentItemId, outputItemId, workOrderId } = await createProductionFixture('wo-batch-drift', [
    { quantity: 6, unitCost: 4 }
  ]);
  const { tenantId, pool: db, topology } = harness;
  const idempotencyKey = `wo-batch-drift-${randomUUID()}`;
  const requestBody = {
    occurredAt: '2026-02-23T00:00:00.000Z',
    consumeLines: [
      {
        componentItemId,
        fromLocationId: topology.defaults.SELLABLE.id,
        uom: 'each',
        quantity: 6
      }
    ],
    produceLines: [
      {
        outputItemId,
        toLocationId: topology.defaults.QA.id,
        uom: 'each',
        quantity: 6
      }
    ]
  };

  const first = await harness.recordBatch(
    workOrderId,
    requestBody,
    {},
    { idempotencyKey }
  );

  await db.query(
    `INSERT INTO inventory_movement_lines (
        id,
        tenant_id,
        movement_id,
        source_line_id,
        item_id,
        location_id,
        quantity_delta,
        uom,
        quantity_delta_entered,
        uom_entered,
        quantity_delta_canonical,
        canonical_uom,
        uom_dimension,
        unit_cost,
        extended_cost,
        reason_code,
        line_notes,
        created_at
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        -1,
        'each',
        -1,
        'each',
        -1,
        'each',
        'count',
        0,
        0,
        'tamper_issue',
        'tamper',
        now()
      )`,
    [
      randomUUID(),
      tenantId,
      first.issueMovementId,
      'tamper-issue-line',
      componentItemId,
      topology.defaults.SELLABLE.id
    ]
  );

  await expectServiceError(
    () => harness.recordBatch(workOrderId, requestBody, {}, { idempotencyKey }),
    'REPLAY_CORRUPTION_DETECTED'
  );
});

test('record-batch replay fails when WIP valuation ledger integrity is broken', async () => {
  const { harness, componentItemId, outputItemId, workOrderId } = await createProductionFixture('wo-batch-wip', [
    { quantity: 6, unitCost: 4 }
  ]);
  const { tenantId, pool: db, topology } = harness;
  const idempotencyKey = `wo-batch-wip-${randomUUID()}`;
  const requestBody = {
    occurredAt: '2026-02-24T00:00:00.000Z',
    consumeLines: [
      {
        componentItemId,
        fromLocationId: topology.defaults.SELLABLE.id,
        uom: 'each',
        quantity: 6
      }
    ],
    produceLines: [
      {
        outputItemId,
        toLocationId: topology.defaults.QA.id,
        uom: 'each',
        quantity: 6
      }
    ]
  };

  const first = await harness.recordBatch(
    workOrderId,
    requestBody,
    {},
    { idempotencyKey }
  );

  await db.query(
    `UPDATE work_order_wip_valuation_records
        SET value_delta = ABS(value_delta)
      WHERE tenant_id = $1
        AND inventory_movement_id = $2
        AND valuation_type = 'report'`,
    [tenantId, first.receiveMovementId]
  );

  await expectServiceError(
    () => harness.recordBatch(workOrderId, requestBody, {}, { idempotencyKey }),
    'WO_WIP_INTEGRITY_FAILED'
  );
});
