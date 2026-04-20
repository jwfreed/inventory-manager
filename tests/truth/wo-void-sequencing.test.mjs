import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../helpers/service-harness.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// WO Void Cross-Workflow Sequencing Tests
//
// The sequencing-validity test already proves WO void is blocked after QC move.
// These tests extend WO void coverage to:
//   1. WO void after downstream shipment of produced output
//   2. WO void after downstream transfer of produced output
//   3. Concurrent WO void attempts converge on a single compensating set
// ─────────────────────────────────────────────────────────────────────────────

async function setupProductionWithOutput(harness) {
  const { topology } = harness;
  const component = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'WV-COMP',
    type: 'raw'
  });
  const output = await harness.createItem({
    defaultLocationId: topology.defaults.QA.id,
    skuPrefix: 'WV-OUT',
    type: 'finished'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: component.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 20,
    unitCost: 5
  });

  const bom = await harness.createBomAndActivate({
    outputItemId: output.id,
    components: [{ componentItemId: component.id, quantityPer: 2 }],
    suffix: randomUUID().slice(0, 6)
  });
  const wo = await harness.createWorkOrder({
    kind: 'production',
    outputItemId: output.id,
    outputUom: 'each',
    quantityPlanned: 5,
    bomId: bom.id,
    defaultConsumeLocationId: topology.defaults.SELLABLE.id,
    defaultProduceLocationId: topology.defaults.QA.id
  });

  const reportKey = `wv-report:${randomUUID()}`;
  const report = await harness.reportProduction(
    wo.id,
    {
      warehouseId: topology.warehouse.id,
      outputQty: 5,
      outputUom: 'each',
      occurredAt: '2026-07-10T00:00:00.000Z',
      idempotencyKey: reportKey
    },
    {},
    { idempotencyKey: reportKey }
  );

  return { component, output, wo, report };
}

test('WO void is blocked after produced output is shipped', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-wv-ship',
    tenantName: 'Truth WO Void After Ship'
  });
  const { topology, tenantId, pool: db } = harness;
  const customer = await harness.createCustomer('WV-SHIP');

  const { component, output, wo, report } = await setupProductionWithOutput(harness);

  // QC accept all 5 output → QA to SELLABLE
  const qcKey = `wv-qc-accept:${randomUUID()}`;
  await harness.qcWarehouseDisposition(
    'accept',
    {
      warehouseId: topology.warehouse.id,
      itemId: output.id,
      quantity: 5,
      uom: 'each',
      idempotencyKey: qcKey
    },
    { type: 'system', id: null },
    { idempotencyKey: qcKey }
  );

  // Ship 2 of the 5 accepted units
  const order = await harness.createSalesOrder({
    soNumber: `SO-WV-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'submitted',
    warehouseId: topology.warehouse.id,
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ itemId: output.id, uom: 'each', quantityOrdered: 2 }]
  });
  const shipment = await harness.createShipment({
    salesOrderId: order.id,
    shippedAt: '2026-07-11T00:00:00.000Z',
    shipFromLocationId: topology.defaults.SELLABLE.id,
    lines: [{ salesOrderLineId: order.lines[0].id, uom: 'each', quantityShipped: 2 }]
  });
  await harness.postShipment(shipment.id, {
    idempotencyKey: `wv-ship:${randomUUID()}`,
    actor: { type: 'system', id: null }
  });

  // Void should be blocked — output has left the building
  await assert.rejects(
    harness.voidProductionReport(
      wo.id,
      {
        workOrderExecutionId: report.productionReportId,
        reason: 'must fail after shipped',
        idempotencyKey: `wv-void-ship:${randomUUID()}`
      },
      { type: 'system', id: null }
    ),
    (error) => {
      const code = error?.code ?? error?.message;
      assert.ok(
        code === 'WO_VOID_OUTPUT_ALREADY_MOVED' || code === 'WO_VOID_OUTPUT_CONSUMED',
        `expected WO_VOID_OUTPUT_ALREADY_MOVED or WO_VOID_OUTPUT_CONSUMED, got ${code}`
      );
      return true;
    }
  );

  // No void movements created
  const voidResult = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_id = $2
        AND source_type IN ('work_order_batch_void_components', 'work_order_batch_void_output')`,
    [tenantId, report.productionReportId]
  );
  assert.equal(Number(voidResult.rows[0]?.count ?? 0), 0);
});

test('WO void is blocked after produced output is transferred away', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-wv-xfer',
    tenantName: 'Truth WO Void After Transfer'
  });
  const { topology, tenantId, pool: db } = harness;
  const store = await harness.createWarehouseWithSellable('WV-XFER-DEST');

  const { component, output, wo, report } = await setupProductionWithOutput(harness);

  // QC accept all 5 → QA to SELLABLE
  const qcKey = `wv-xfer-qc:${randomUUID()}`;
  await harness.qcWarehouseDisposition(
    'accept',
    {
      warehouseId: topology.warehouse.id,
      itemId: output.id,
      quantity: 5,
      uom: 'each',
      idempotencyKey: qcKey
    },
    { type: 'system', id: null },
    { idempotencyKey: qcKey }
  );

  // Transfer 3 to another warehouse
  await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId: output.id,
    quantity: 3,
    uom: 'each',
    reasonCode: 'wv_transfer',
    notes: 'Transfer output away',
    idempotencyKey: `wv-xfer:${randomUUID()}`
  });

  // Void should be blocked
  await assert.rejects(
    harness.voidProductionReport(
      wo.id,
      {
        workOrderExecutionId: report.productionReportId,
        reason: 'must fail after transfer',
        idempotencyKey: `wv-void-xfer:${randomUUID()}`
      },
      { type: 'system', id: null }
    ),
    (error) => {
      const code = error?.code ?? error?.message;
      assert.ok(
        code === 'WO_VOID_OUTPUT_ALREADY_MOVED' || code === 'WO_VOID_OUTPUT_CONSUMED',
        `expected WO_VOID_OUTPUT_ALREADY_MOVED or WO_VOID_OUTPUT_CONSUMED, got ${code}`
      );
      return true;
    }
  );

  // No void movements created
  const voidResult = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_id = $2
        AND source_type IN ('work_order_batch_void_components', 'work_order_batch_void_output')`,
    [tenantId, report.productionReportId]
  );
  assert.equal(Number(voidResult.rows[0]?.count ?? 0), 0);

  // Balances unchanged: component at SELLABLE still reduced, output split across locations
  const compOnHand = await harness.readOnHand(component.id, topology.defaults.SELLABLE.id);
  const outSellable = await harness.readOnHand(output.id, topology.defaults.SELLABLE.id);
  const outStore = await harness.readOnHand(output.id, store.sellable.id);
  assert.equal(compOnHand, 10, 'components consumed by production');
  assert.equal(outSellable, 2, 'remaining output at SELLABLE');
  assert.equal(outStore, 3, 'transferred output at store');
});

test('concurrent WO void attempts converge on a single compensating movement set', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'truth-wv-conc',
    tenantName: 'Truth WO Void Concurrent'
  });
  const { topology, tenantId, pool: db } = harness;

  const { component, output, wo, report } = await setupProductionWithOutput(harness);

  // Output is still in QA (not moved) → void should succeed
  // Race two void attempts
  const outcomes = await harness.runConcurrently([
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.voidProductionReport(
        wo.id,
        {
          workOrderExecutionId: report.productionReportId,
          reason: 'concurrent void A',
          idempotencyKey: `wv-void-a:${randomUUID()}`
        },
        { type: 'system', id: null }
      );
    },
    async ({ waitForStart }) => {
      await waitForStart();
      return harness.voidProductionReport(
        wo.id,
        {
          workOrderExecutionId: report.productionReportId,
          reason: 'concurrent void B',
          idempotencyKey: `wv-void-b:${randomUUID()}`
        },
        { type: 'system', id: null }
      );
    }
  ]);

  const fulfilled = outcomes.filter((e) => e.status === 'fulfilled');
  const rejected = outcomes.filter((e) => e.status === 'rejected');

  // At least one must succeed, and both reporting success is also acceptable
  // (the second is idempotent replay)
  assert.ok(fulfilled.length >= 1, 'at least one void succeeded');

  // Exactly 2 void movements (one for component return, one for output reversal)
  const voidMovements = await db.query(
    `SELECT id, movement_type, source_type
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_id = $2
        AND source_type IN ('work_order_batch_void_components', 'work_order_batch_void_output')
      ORDER BY source_type`,
    [tenantId, report.productionReportId]
  );
  assert.equal(voidMovements.rowCount, 2, 'exactly 2 void movements (component return + output reversal)');

  // Components restored
  const compOnHand = await harness.readOnHand(component.id, topology.defaults.SELLABLE.id);
  assert.equal(compOnHand, 20, 'components fully restored');

  // Output removed from QA
  const outOnHand = await harness.readOnHand(output.id, topology.defaults.QA.id);
  assert.equal(outOnHand, 0, 'output reversed from QA');

  await harness.runStrictInvariants();
});
