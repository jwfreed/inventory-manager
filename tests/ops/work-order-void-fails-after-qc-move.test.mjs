import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from './helpers/service-harness.mjs';

test('void-report-production fails loud once output moved from QA by QC accept', { timeout: 240000 }, async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'wo-void-moved',
    tenantName: 'WO Void Moved Tenant'
  });
  const { tenantId, pool: db, topology } = harness;

  const component = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'VOID-MOVED-RAW',
    type: 'raw'
  });
  const output = await harness.createItem({
    defaultLocationId: topology.defaults.QA.id,
    skuPrefix: 'VOID-MOVED-FG',
    type: 'finished'
  });

  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: component.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 40,
    unitCost: 8
  });

  const bom = await harness.createBomAndActivate({
    outputItemId: output.id,
    components: [{ componentItemId: component.id, quantityPer: 2 }],
    suffix: randomUUID().slice(0, 6)
  });
  const workOrder = await harness.createWorkOrder({
    kind: 'production',
    outputItemId: output.id,
    outputUom: 'each',
    quantityPlanned: 20,
    bomId: bom.id,
    defaultConsumeLocationId: topology.defaults.SELLABLE.id,
    defaultProduceLocationId: topology.defaults.QA.id
  });

  const reportKey = `wo-void-moved-report:${randomUUID()}`;
  const report = await harness.reportProduction(
    workOrder.id,
    {
      warehouseId: topology.warehouse.id,
      outputQty: 20,
      outputUom: 'each',
      occurredAt: '2026-02-22T00:00:00.000Z',
      idempotencyKey: reportKey
    },
    {},
    { idempotencyKey: reportKey }
  );

  const qcAcceptKey = `wo-void-moved-qc:${randomUUID()}`;
  const qcAccept = await harness.qcWarehouseDisposition(
    'accept',
    {
      warehouseId: topology.warehouse.id,
      itemId: output.id,
      quantity: 5,
      uom: 'each',
      idempotencyKey: qcAcceptKey
    },
    { type: 'system', id: null },
    { idempotencyKey: qcAcceptKey }
  );
  assert.equal(qcAccept.action, 'accept');

  await assert.rejects(
    harness.voidProductionReport(
      workOrder.id,
      {
        workOrderExecutionId: report.productionReportId,
        reason: 'should fail after QA move',
        idempotencyKey: `wo-void-moved:${randomUUID()}`
      },
      { type: 'system', id: null }
    ),
    (error) => {
      assert.equal(error?.code ?? error?.message, 'WO_VOID_OUTPUT_ALREADY_MOVED');
      return true;
    }
  );

  const voidMovementCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_id = $2
        AND source_type IN ('work_order_batch_void_components', 'work_order_batch_void_output')`,
    [tenantId, report.productionReportId]
  );
  assert.equal(Number(voidMovementCount.rows[0]?.count ?? 0), 0);
});
