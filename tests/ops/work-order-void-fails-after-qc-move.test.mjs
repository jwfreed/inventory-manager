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
  qcAcceptReceiptLine
} from './helpers/work-order-fixtures.mjs';

function extractErrorCode(payload) {
  if (!payload) return null;
  if (typeof payload.error === 'string') return payload.error;
  if (typeof payload.error?.code === 'string') return payload.error.code;
  return null;
}

test('void-report-production fails loud once output moved from QA by QC accept', { timeout: 240000 }, async () => {
  const tenantSlug = `wo-void-moved-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'WO Void Moved Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  assert.ok(token);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const component = await createItem(token, defaults.SELLABLE.id, 'VOID-MOVED-RAW', 'raw');
  const output = await createItem(token, defaults.QA.id, 'VOID-MOVED-FG', 'finished');

  const receiptLine = await createReceipt({
    token,
    vendorId,
    itemId: component,
    locationId: defaults.SELLABLE.id,
    quantity: 100,
    unitCost: 8,
    keySuffix: tenantSlug
  });
  await qcAcceptReceiptLine(token, receiptLine, 100);

  const bomId = await createBom(token, output, [{ componentItemId: component, quantityPer: 2 }], tenantSlug);
  const workOrder = await createWorkOrder(token, {
    kind: 'production',
    outputItemId: output,
    outputUom: 'each',
    quantityPlanned: 20,
    bomId,
    defaultConsumeLocationId: defaults.SELLABLE.id,
    defaultProduceLocationId: defaults.QA.id
  });

  const reportKey = `wo-void-moved-report:${tenantSlug}`;
  const reportRes = await apiRequest('POST', `/work-orders/${workOrder.id}/report-production`, {
    token,
    headers: { 'Idempotency-Key': reportKey },
    body: {
      warehouseId: warehouse.id,
      outputQty: 20,
      outputUom: 'each',
      occurredAt: '2026-02-22T00:00:00.000Z',
      idempotencyKey: reportKey
    }
  });
  assert.equal(reportRes.res.status, 201, JSON.stringify(reportRes.payload));

  const qcAcceptKey = `wo-void-moved-qc:${tenantSlug}`;
  const qcAcceptRes = await apiRequest('POST', '/qc/accept', {
    token,
    headers: { 'Idempotency-Key': qcAcceptKey },
    body: {
      warehouseId: warehouse.id,
      itemId: output,
      quantity: 5,
      uom: 'each',
      idempotencyKey: qcAcceptKey
    }
  });
  assert.equal(qcAcceptRes.res.status, 201, JSON.stringify(qcAcceptRes.payload));

  const voidKey = `wo-void-moved:${tenantSlug}`;
  const voidRes = await apiRequest('POST', `/work-orders/${workOrder.id}/void-report-production`, {
    token,
    headers: { 'Idempotency-Key': voidKey },
    body: {
      workOrderExecutionId: reportRes.payload.productionReportId,
      reason: 'should fail after QA move',
      idempotencyKey: voidKey
    }
  });
  assert.equal(voidRes.res.status, 409, JSON.stringify(voidRes.payload));
  assert.equal(extractErrorCode(voidRes.payload), 'WO_VOID_OUTPUT_ALREADY_MOVED');

  const voidMovementCount = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_id = $2
        AND source_type IN ('work_order_batch_void_components', 'work_order_batch_void_output')`,
    [tenantId, reportRes.payload.productionReportId]
  );
  assert.equal(Number(voidMovementCount.rows[0].count), 0);
});
