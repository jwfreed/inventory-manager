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

function toAvailableToPromise(row) {
  if (!row || typeof row !== 'object') return 0;
  const preferred = row.availableToPromise ?? row.available_to_promise ?? row.availableQty ?? row.available_qty;
  if (preferred !== undefined && preferred !== null) return Number(preferred);
  const onHand = Number(row.onHand ?? row.on_hand ?? 0);
  const reserved = Number(row.reserved ?? row.reserved_qty ?? 0);
  const allocated = Number(row.allocated ?? row.allocated_qty ?? 0);
  return onHand - reserved - allocated;
}

test('report-scrap moves output from QA to SCRAP with FIFO relocation and ATP exclusion', { timeout: 240000 }, async () => {
  const tenantSlug = `wo-scrap-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'WO Scrap Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  assert.ok(token);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);
  const component = await createItem(token, defaults.SELLABLE.id, 'SCRAP-RAW', 'raw');
  const output = await createItem(token, defaults.QA.id, 'SCRAP-FG', 'finished');

  const receiptLine = await createReceipt({
    token,
    vendorId,
    itemId: component,
    locationId: defaults.SELLABLE.id,
    quantity: 120,
    unitCost: 6,
    keySuffix: tenantSlug
  });
  await qcAcceptReceiptLine(token, receiptLine, 120);

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

  const reportKey = `wo-scrap-report:${tenantSlug}`;
  const reportRes = await apiRequest('POST', `/work-orders/${workOrder.id}/report-production`, {
    token,
    headers: { 'Idempotency-Key': reportKey },
    body: {
      warehouseId: warehouse.id,
      outputQty: 20,
      outputUom: 'each',
      occurredAt: '2026-02-24T00:00:00.000Z',
      idempotencyKey: reportKey
    }
  });
  assert.equal(reportRes.res.status, 201, JSON.stringify(reportRes.payload));
  const reservationSnapshotBeforeScrap = await db.query(
    `SELECT item_id,
            status,
            quantity_reserved::numeric AS quantity_reserved,
            COALESCE(quantity_fulfilled, 0)::numeric AS quantity_fulfilled
       FROM inventory_reservations
      WHERE tenant_id = $1
        AND demand_type = 'work_order_component'
        AND demand_id = $2
      ORDER BY item_id ASC`,
    [tenantId, workOrder.id]
  );

  const preQa = await readOnHand(db, tenantId, output, defaults.QA.id);
  const preScrap = await readOnHand(db, tenantId, output, defaults.SCRAP.id);

  const scrapKey = `wo-scrap:${tenantSlug}`;
  const scrapBody = {
    workOrderExecutionId: reportRes.payload.productionReportId,
    quantity: 7,
    uom: 'each',
    reasonCode: 'work_order_scrap',
    idempotencyKey: scrapKey
  };
  const scrapRes = await apiRequest('POST', `/work-orders/${workOrder.id}/report-scrap`, {
    token,
    headers: { 'Idempotency-Key': scrapKey },
    body: scrapBody
  });
  assert.equal(scrapRes.res.status, 201, JSON.stringify(scrapRes.payload));
  assert.equal(scrapRes.payload.replayed, false);

  const scrapReplay = await apiRequest('POST', `/work-orders/${workOrder.id}/report-scrap`, {
    token,
    headers: { 'Idempotency-Key': scrapKey },
    body: scrapBody
  });
  assert.equal(scrapReplay.res.status, 200, JSON.stringify(scrapReplay.payload));
  assert.equal(scrapReplay.payload.scrapMovementId, scrapRes.payload.scrapMovementId);

  const postQa = await readOnHand(db, tenantId, output, defaults.QA.id);
  const postScrap = await readOnHand(db, tenantId, output, defaults.SCRAP.id);
  assert.ok(Math.abs(postQa - (preQa - 7)) < 1e-6, `qa drift pre=${preQa} post=${postQa}`);
  assert.ok(Math.abs(postScrap - (preScrap + 7)) < 1e-6, `scrap drift pre=${preScrap} post=${postScrap}`);
  const reservationSnapshotAfterScrap = await db.query(
    `SELECT item_id,
            status,
            quantity_reserved::numeric AS quantity_reserved,
            COALESCE(quantity_fulfilled, 0)::numeric AS quantity_fulfilled
       FROM inventory_reservations
      WHERE tenant_id = $1
        AND demand_type = 'work_order_component'
        AND demand_id = $2
      ORDER BY item_id ASC`,
    [tenantId, workOrder.id]
  );
  assert.deepEqual(
    reservationSnapshotAfterScrap.rows.map((row) => ({
      itemId: row.item_id,
      status: row.status,
      reserved: Number(row.quantity_reserved),
      fulfilled: Number(row.quantity_fulfilled)
    })),
    reservationSnapshotBeforeScrap.rows.map((row) => ({
      itemId: row.item_id,
      status: row.status,
      reserved: Number(row.quantity_reserved),
      fulfilled: Number(row.quantity_fulfilled)
    }))
  );

  const movementRoleCheck = await db.query(
    `SELECT SUM(CASE WHEN qty < 0 AND role = 'QA' THEN 1 ELSE 0 END)::int AS qa_out,
            SUM(CASE WHEN qty > 0 AND role = 'SCRAP' THEN 1 ELSE 0 END)::int AS scrap_in
       FROM (
         SELECT l.role,
                COALESCE(iml.quantity_delta_canonical, iml.quantity_delta)::numeric AS qty
           FROM inventory_movement_lines iml
           JOIN locations l
             ON l.id = iml.location_id
            AND l.tenant_id = iml.tenant_id
          WHERE iml.tenant_id = $1
            AND iml.movement_id = $2
       ) scoped`,
    [tenantId, scrapRes.payload.scrapMovementId]
  );
  assert.equal(Number(movementRoleCheck.rows[0].qa_out ?? 0), 1);
  assert.equal(Number(movementRoleCheck.rows[0].scrap_in ?? 0), 1);

  const atpRes = await apiRequest('GET', '/atp', {
    token,
    params: { warehouseId: warehouse.id, itemId: output }
  });
  assert.equal(atpRes.res.status, 200, JSON.stringify(atpRes.payload));
  const atpRows = atpRes.payload?.data ?? [];
  const availableTotal = atpRows.reduce((sum, row) => sum + toAvailableToPromise(row), 0);
  assert.ok(Math.abs(availableTotal) < 1e-6, `expected no ATP from QA/SCRAP only, got ${availableTotal}`);

  await runStrictInvariantsForTenant(tenantId);
});
