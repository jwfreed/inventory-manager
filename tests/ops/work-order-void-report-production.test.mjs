import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import {
  adminEmail,
  adminPassword,
  apiRequest,
  createBom,
  createItem,
  createReceipt,
  createVendor,
  createWorkOrder,
  qcAcceptReceiptLine,
  readOnHand,
  runStrictInvariantsForTenant
} from './helpers/work-order-fixtures.mjs';

test('void-report-production posts compensating movements and restores pre-report inventory state', { timeout: 240000 }, async () => {
  const tenantSlug = `wo-void-ok-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'WO Void Happy Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  assert.ok(token);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const componentA = await createItem(token, defaults.SELLABLE.id, 'VOID-RAW-A', 'raw');
  const componentB = await createItem(token, defaults.SELLABLE.id, 'VOID-PACK-B', 'raw');
  const outputItem = await createItem(token, defaults.QA.id, 'VOID-FG', 'finished');

  const receiptLineA = await createReceipt({
    token,
    vendorId,
    itemId: componentA,
    locationId: defaults.SELLABLE.id,
    quantity: 200,
    unitCost: 10,
    keySuffix: `${tenantSlug}:A`
  });
  await qcAcceptReceiptLine(token, receiptLineA, 200);
  const receiptLineB = await createReceipt({
    token,
    vendorId,
    itemId: componentB,
    locationId: defaults.SELLABLE.id,
    quantity: 200,
    unitCost: 3,
    keySuffix: `${tenantSlug}:B`
  });
  await qcAcceptReceiptLine(token, receiptLineB, 200);

  const bomId = await createBom(token, outputItem, [
    { componentItemId: componentA, quantityPer: 2 },
    { componentItemId: componentB, quantityPer: 1 }
  ], tenantSlug);
  const workOrder = await createWorkOrder(token, {
    kind: 'production',
    outputItemId: outputItem,
    outputUom: 'each',
    quantityPlanned: 20,
    bomId,
    defaultConsumeLocationId: defaults.SELLABLE.id,
    defaultProduceLocationId: defaults.QA.id
  });

  const preA = await readOnHand(db, tenantId, componentA, defaults.SELLABLE.id);
  const preB = await readOnHand(db, tenantId, componentB, defaults.SELLABLE.id);
  const preQa = await readOnHand(db, tenantId, outputItem, defaults.QA.id);

  const reportKey = `wo-void-report:${tenantSlug}`;
  const reportRes = await apiRequest('POST', `/work-orders/${workOrder.id}/report-production`, {
    token,
    headers: { 'Idempotency-Key': reportKey },
    body: {
      warehouseId: warehouse.id,
      outputQty: 20,
      outputUom: 'each',
      occurredAt: '2026-02-20T00:00:00.000Z',
      idempotencyKey: reportKey
    }
  });
  assert.equal(reportRes.res.status, 201, JSON.stringify(reportRes.payload));

  const voidKey = `wo-void:${tenantSlug}`;
  const voidBody = {
    workOrderExecutionId: reportRes.payload.productionReportId,
    reason: 'test correction',
    idempotencyKey: voidKey
  };
  const firstVoid = await apiRequest('POST', `/work-orders/${workOrder.id}/void-report-production`, {
    token,
    headers: { 'Idempotency-Key': voidKey },
    body: voidBody
  });
  assert.equal(firstVoid.res.status, 201, JSON.stringify(firstVoid.payload));
  assert.equal(firstVoid.payload.replayed, false);

  const replayVoid = await apiRequest('POST', `/work-orders/${workOrder.id}/void-report-production`, {
    token,
    headers: { 'Idempotency-Key': voidKey },
    body: voidBody
  });
  assert.equal(replayVoid.res.status, 200, JSON.stringify(replayVoid.payload));
  assert.equal(
    replayVoid.payload.componentReturnMovementId,
    firstVoid.payload.componentReturnMovementId
  );
  assert.equal(
    replayVoid.payload.outputReversalMovementId,
    firstVoid.payload.outputReversalMovementId
  );

  const voidMovementCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_id = $2
        AND source_type IN ('work_order_batch_void_components', 'work_order_batch_void_output')`,
    [tenantId, reportRes.payload.productionReportId]
  );
  assert.equal(Number(voidMovementCount.rows[0].count), 2);

  const postA = await readOnHand(db, tenantId, componentA, defaults.SELLABLE.id);
  const postB = await readOnHand(db, tenantId, componentB, defaults.SELLABLE.id);
  const postQa = await readOnHand(db, tenantId, outputItem, defaults.QA.id);
  assert.ok(Math.abs(postA - preA) < 1e-6, `componentA on_hand drift pre=${preA} post=${postA}`);
  assert.ok(Math.abs(postB - preB) < 1e-6, `componentB on_hand drift pre=${preB} post=${postB}`);
  assert.ok(Math.abs(postQa - preQa) < 1e-6, `output QA on_hand drift pre=${preQa} post=${postQa}`);

  const costSumRes = await db.query(
    `SELECT COALESCE(SUM(
              COALESCE(
                extended_cost,
                COALESCE(unit_cost, 0) * COALESCE(quantity_delta_canonical, quantity_delta)
              )
            ), 0)::numeric AS signed_cost
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = ANY($2::uuid[])`,
    [
      tenantId,
      [
        reportRes.payload.componentIssueMovementId,
        reportRes.payload.productionReceiptMovementId,
        firstVoid.payload.componentReturnMovementId,
        firstVoid.payload.outputReversalMovementId
      ]
    ]
  );
  const signedCost = Number(costSumRes.rows[0].signed_cost);
  assert.ok(Math.abs(signedCost) < 0.0001, `expected net-zero signed movement cost, got ${signedCost}`);

  await runStrictInvariantsForTenant(tenantId);
});
