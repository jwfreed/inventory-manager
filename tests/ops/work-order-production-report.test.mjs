import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const execFileAsync = promisify(execFile);
const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';

async function apiRequest(method, path, { token, body, params, headers } = {}) {
  const url = new URL(baseUrl + path);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  const mergedHeaders = { 'Content-Type': 'application/json', ...(headers ?? {}) };
  if (token) mergedHeaders.Authorization = `Bearer ${token}`;
  const res = await fetch(url.toString(), {
    method,
    headers: mergedHeaders,
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { res, payload };
}

async function createVendor(token) {
  const code = `V-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/vendors', {
    token,
    body: { code, name: `Vendor ${code}` }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createItem(token, defaultLocationId, skuPrefix, type = 'raw') {
  const sku = `${skuPrefix}-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      type,
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId,
      active: true
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createReceipt({
  token,
  vendorId,
  itemId,
  locationId,
  quantity,
  unitCost,
  keySuffix,
  receivedAt = '2026-01-11T00:00:00.000Z'
}) {
  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId: locationId,
      receivingLocationId: locationId,
      expectedDate: '2026-01-10',
      status: 'approved',
      lines: [{ itemId, uom: 'each', quantityOrdered: quantity, unitCost, currencyCode: 'THB' }]
    }
  });
  assert.equal(poRes.res.status, 201, JSON.stringify(poRes.payload));

  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `wo-report-receipt:${keySuffix}:${itemId}` },
    body: {
      purchaseOrderId: poRes.payload.id,
      receivedAt,
      lines: [
        {
          purchaseOrderLineId: poRes.payload.lines[0].id,
          uom: 'each',
          quantityReceived: quantity,
          unitCost
        }
      ]
    }
  });
  assert.equal(receiptRes.res.status, 201, JSON.stringify(receiptRes.payload));
  return receiptRes.payload.lines[0].id;
}

async function createBom(token, outputItemId, components, suffix) {
  const res = await apiRequest('POST', '/boms', {
    token,
    body: {
      bomCode: `BOM-${suffix}-${randomUUID().slice(0, 6)}`,
      outputItemId,
      defaultUom: 'each',
      version: {
        versionNumber: 1,
        yieldQuantity: 1,
        yieldUom: 'each',
        components: components.map((component, index) => ({
          lineNumber: index + 1,
          componentItemId: component.componentItemId,
          uom: 'each',
          quantityPer: component.quantityPer
        }))
      }
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));

  const activateRes = await apiRequest('POST', `/boms/${res.payload.versions[0].id}/activate`, {
    token,
    body: { effectiveFrom: '2026-01-01T00:00:00.000Z' }
  });
  assert.equal(activateRes.res.status, 200, JSON.stringify(activateRes.payload));
  return res.payload.id;
}

async function createWorkOrder(token, params) {
  const res = await apiRequest('POST', '/work-orders', {
    token,
    body: params
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload;
}

async function qcAcceptReceiptLine(token, receiptLineId, quantity) {
  const res = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': `wo-report-qc:${receiptLineId}` },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity,
      uom: 'each',
      actorType: 'system'
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
}

async function runStrictInvariantsForTenant(tenantId) {
  await execFileAsync(
    process.execPath,
    ['scripts/inventory_invariants_check.mjs', '--strict', '--tenant-id', tenantId, '--limit', '25'],
    {
      cwd: process.cwd(),
      env: { ...process.env, ENABLE_SCHEDULER: 'false' },
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024
    }
  );
}

test('report-production posts component issue + QA receipt with FIFO cost conservation and idempotency replay', { timeout: 240000 }, async () => {
  const tenantSlug = `wo-report-happy-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'WO Report Production Happy Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  assert.ok(token);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const vendorId = await createVendor(token);

  const componentA = await createItem(token, defaults.SELLABLE.id, 'RAW-A', 'raw');
  const componentB = await createItem(token, defaults.SELLABLE.id, 'PACK-B', 'raw');
  const outputItem = await createItem(token, defaults.QA.id, 'FG', 'finished');

  const receiptLineA = await createReceipt({
    token,
    vendorId,
    itemId: componentA,
    locationId: defaults.SELLABLE.id,
    quantity: 200,
    unitCost: 10,
    keySuffix: tenantSlug
  });
  await qcAcceptReceiptLine(token, receiptLineA, 200);
  const receiptLineB = await createReceipt({
    token,
    vendorId,
    itemId: componentB,
    locationId: defaults.SELLABLE.id,
    quantity: 200,
    unitCost: 2,
    keySuffix: tenantSlug
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

  const idempotencyKey = `wo-report:${tenantSlug}:1`;
  const reportBody = {
    warehouseId: warehouse.id,
    outputQty: 20,
    outputUom: 'each',
    occurredAt: '2026-02-10T00:00:00.000Z',
    notes: 'phase2 happy path',
    idempotencyKey
  };

  const first = await apiRequest('POST', `/work-orders/${workOrder.id}/report-production`, {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: reportBody
  });
  assert.equal(first.res.status, 201, JSON.stringify(first.payload));
  assert.equal(first.payload.replayed, false);

  const replay = await apiRequest('POST', `/work-orders/${workOrder.id}/report-production`, {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: reportBody
  });
  assert.equal(replay.res.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.payload.replayed, true);
  assert.equal(replay.payload.componentIssueMovementId, first.payload.componentIssueMovementId);
  assert.equal(replay.payload.productionReceiptMovementId, first.payload.productionReceiptMovementId);

  const issueLines = await db.query(
    `SELECT item_id, SUM(COALESCE(quantity_delta_canonical, quantity_delta))::numeric AS qty
       FROM inventory_movement_lines
      WHERE movement_id = $1
      GROUP BY item_id`,
    [first.payload.componentIssueMovementId]
  );
  const issueByItem = new Map(issueLines.rows.map((row) => [row.item_id, Number(row.qty)]));
  assert.ok(Math.abs((issueByItem.get(componentA) ?? 0) + 40) < 1e-6, `componentA issue qty=${issueByItem.get(componentA)}`);
  assert.ok(Math.abs((issueByItem.get(componentB) ?? 0) + 20) < 1e-6, `componentB issue qty=${issueByItem.get(componentB)}`);
  const issueSourceRoleRes = await db.query(
    `SELECT DISTINCT l.role, l.is_sellable
       FROM inventory_movement_lines iml
       JOIN locations l
         ON l.id = iml.location_id
        AND l.tenant_id = iml.tenant_id
      WHERE iml.tenant_id = $1
        AND iml.movement_id = $2
        AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) < 0`,
    [tenantId, first.payload.componentIssueMovementId]
  );
  assert.ok(issueSourceRoleRes.rowCount > 0, 'expected backflush consume lines to exist');
  assert.ok(
    issueSourceRoleRes.rows.every((row) => row.role === 'SELLABLE' && row.is_sellable === true),
    `expected all backflush source lines to be SELLABLE/sellable=true; got ${JSON.stringify(issueSourceRoleRes.rows)}`
  );

  const receiveLine = await db.query(
    `SELECT location_id, SUM(COALESCE(quantity_delta_canonical, quantity_delta))::numeric AS qty
       FROM inventory_movement_lines
      WHERE movement_id = $1
        AND item_id = $2
      GROUP BY location_id`,
    [first.payload.productionReceiptMovementId, outputItem]
  );
  assert.equal(receiveLine.rowCount, 1);
  assert.equal(receiveLine.rows[0].location_id, defaults.QA.id);
  assert.ok(Math.abs(Number(receiveLine.rows[0].qty) - 20) < 1e-6);

  const componentCostRes = await db.query(
    `SELECT COALESCE(SUM(extended_cost), 0)::numeric AS total_component_cost
       FROM cost_layer_consumptions
      WHERE tenant_id = $1
        AND movement_id = $2
        AND consumption_type = 'production_input'`,
    [tenantId, first.payload.componentIssueMovementId]
  );
  const fgCostRes = await db.query(
    `SELECT COALESCE(SUM(COALESCE(extended_cost, 0)), 0)::numeric AS total_fg_cost
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
        AND COALESCE(quantity_delta_canonical, quantity_delta) > 0`,
    [tenantId, first.payload.productionReceiptMovementId]
  );
  const componentCost = Number(componentCostRes.rows[0].total_component_cost);
  const fgCost = Number(fgCostRes.rows[0].total_fg_cost);
  assert.ok(Math.abs(componentCost - fgCost) < 0.0001, `componentCost=${componentCost}, fgCost=${fgCost}`);

  await runStrictInvariantsForTenant(tenantId);
});

test('report-production retry with same idempotency key completes lot-linking without duplicate posting', { timeout: 240000 }, async () => {
  const tenantSlug = `wo-report-lot-repair-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'WO Report Production Lot Repair Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:lot-repair` });
  const vendorId = await createVendor(token);

  const component = await createItem(token, defaults.SELLABLE.id, 'LOTFIX-RAW', 'raw');
  const outputItem = await createItem(token, defaults.QA.id, 'LOTFIX-FG', 'finished');
  const receiptLine = await createReceipt({
    token,
    vendorId,
    itemId: component,
    locationId: defaults.SELLABLE.id,
    quantity: 20,
    unitCost: 6,
    keySuffix: tenantSlug
  });
  await qcAcceptReceiptLine(token, receiptLine, 20);

  const bomId = await createBom(token, outputItem, [{ componentItemId: component, quantityPer: 1 }], tenantSlug);
  const workOrder = await createWorkOrder(token, {
    kind: 'production',
    outputItemId: outputItem,
    outputUom: 'each',
    quantityPlanned: 10,
    bomId,
    defaultConsumeLocationId: defaults.SELLABLE.id,
    defaultProduceLocationId: defaults.QA.id
  });

  const idempotencyKey = `wo-report:${tenantSlug}:simulate-lot-link-failure`;
  const payload = {
    warehouseId: warehouse.id,
    outputQty: 10,
    outputUom: 'each',
    occurredAt: '2026-02-18T00:00:00.000Z'
  };

  const first = await apiRequest('POST', `/work-orders/${workOrder.id}/report-production`, {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: payload
  });
  assert.equal(first.res.status, 409, JSON.stringify(first.payload));
  assert.equal(first.payload?.error?.code, 'WO_REPORT_LOT_LINK_INCOMPLETE');

  const replay = await apiRequest('POST', `/work-orders/${workOrder.id}/report-production`, {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: payload
  });
  assert.equal(replay.res.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.payload?.replayed, true);
  assert.ok(replay.payload?.lotTracking?.outputLotId, 'replay should complete lot-linking');

  const executionRes = await db.query(
    `SELECT id
       FROM work_order_executions
      WHERE tenant_id = $1
        AND work_order_id = $2
        AND idempotency_key = $3`,
    [tenantId, workOrder.id, idempotencyKey]
  );
  assert.equal(executionRes.rowCount, 1, 'same idempotency key must map to one execution');

  const movementRes = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_id = $2
        AND source_type IN ('work_order_batch_post_issue', 'work_order_batch_post_completion')`,
    [tenantId, executionRes.rows[0].id]
  );
  assert.equal(Number(movementRes.rows[0].count), 2, 'retries must not create extra movements');

  const producedLineRes = await db.query(
    `SELECT id
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
        AND item_id = $3
      LIMIT 1`,
    [tenantId, replay.payload.productionReceiptMovementId, outputItem]
  );
  assert.equal(producedLineRes.rowCount, 1);

  const outputLotId = replay.payload.lotTracking.outputLotId;
  const movementLotRes = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movement_lots
      WHERE tenant_id = $1
        AND inventory_movement_line_id = $2
        AND lot_id = $3`,
    [tenantId, producedLineRes.rows[0].id, outputLotId]
  );
  assert.equal(Number(movementLotRes.rows[0].count), 1, 'movement lot dedupe must be stable under retry');

  const lotLinkRes = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM work_order_lot_links
      WHERE tenant_id = $1
        AND work_order_execution_id = $2
        AND role = 'produce'
        AND lot_id = $3`,
    [tenantId, executionRes.rows[0].id, outputLotId]
  );
  assert.equal(Number(lotLinkRes.rows[0].count), 1, 'produce lot link must be recorded exactly once');
});

test('report-production backflush depletes FIFO layers in order when consumption crosses layers', { timeout: 240000 }, async () => {
  const tenantSlug = `wo-report-fifo-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'WO Report Production FIFO Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  assert.ok(token);

  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:fifo` });
  const vendorId = await createVendor(token);

  const component = await createItem(token, defaults.SELLABLE.id, 'FIFO-COMP', 'raw');
  const outputItem = await createItem(token, defaults.QA.id, 'FIFO-FG', 'finished');

  const receiptLine1 = await createReceipt({
    token,
    vendorId,
    itemId: component,
    locationId: defaults.SELLABLE.id,
    quantity: 15,
    unitCost: 10,
    keySuffix: `${tenantSlug}:1`,
    receivedAt: '2026-01-05T00:00:00.000Z'
  });
  await qcAcceptReceiptLine(token, receiptLine1, 15);
  const receiptLine2 = await createReceipt({
    token,
    vendorId,
    itemId: component,
    locationId: defaults.SELLABLE.id,
    quantity: 20,
    unitCost: 14,
    keySuffix: `${tenantSlug}:2`,
    receivedAt: '2026-01-25T00:00:00.000Z'
  });
  await qcAcceptReceiptLine(token, receiptLine2, 20);

  const preLayers = await db.query(
    `SELECT id, layer_date, unit_cost, remaining_quantity
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
      ORDER BY layer_date ASC, layer_sequence ASC, id ASC`,
    [tenantId, component, defaults.SELLABLE.id]
  );
  assert.ok(preLayers.rowCount >= 2, `expected at least two FIFO layers before posting; got ${preLayers.rowCount}`);

  const bomId = await createBom(token, outputItem, [{ componentItemId: component, quantityPer: 2 }], `${tenantSlug}-bom`);
  const workOrder = await createWorkOrder(token, {
    kind: 'production',
    outputItemId: outputItem,
    outputUom: 'each',
    quantityPlanned: 10,
    bomId,
    defaultConsumeLocationId: defaults.SELLABLE.id,
    defaultProduceLocationId: defaults.QA.id
  });

  const postRes = await apiRequest('POST', `/work-orders/${workOrder.id}/report-production`, {
    token,
    headers: { 'Idempotency-Key': `wo-report-fifo:${tenantSlug}` },
    body: {
      warehouseId: warehouse.id,
      outputQty: 10,
      outputUom: 'each',
      occurredAt: '2026-02-14T00:00:00.000Z'
    }
  });
  assert.equal(postRes.res.status, 201, JSON.stringify(postRes.payload));

  const consumptions = await db.query(
    `SELECT cl.id AS layer_id,
            cl.layer_date,
            clc.consumed_quantity,
            clc.unit_cost,
            clc.extended_cost
       FROM cost_layer_consumptions clc
       JOIN inventory_cost_layers cl
         ON cl.id = clc.cost_layer_id
        AND cl.tenant_id = clc.tenant_id
      WHERE clc.tenant_id = $1
        AND clc.movement_id = $2
        AND clc.consumption_type = 'production_input'
      ORDER BY cl.layer_date ASC, cl.layer_sequence ASC, cl.id ASC`,
    [tenantId, postRes.payload.componentIssueMovementId]
  );
  assert.equal(consumptions.rowCount, 2, JSON.stringify(consumptions.rows));
  assert.equal(consumptions.rows[0].layer_id, preLayers.rows[0].id, 'first (oldest) layer must be consumed first');
  assert.ok(Math.abs(Number(consumptions.rows[0].consumed_quantity) - 15) < 1e-6);
  assert.ok(Math.abs(Number(consumptions.rows[0].unit_cost) - 10) < 1e-6);
  assert.equal(consumptions.rows[1].layer_id, preLayers.rows[1].id, 'second layer should be consumed for remaining qty');
  assert.ok(Math.abs(Number(consumptions.rows[1].consumed_quantity) - 5) < 1e-6);
  assert.ok(Math.abs(Number(consumptions.rows[1].unit_cost) - 14) < 1e-6);

  const issueCostRes = await db.query(
    `SELECT COALESCE(SUM(ABS(COALESCE(extended_cost, 0))), 0)::numeric AS total_issue_cost
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
        AND item_id = $3
        AND COALESCE(quantity_delta_canonical, quantity_delta) < 0`,
    [tenantId, postRes.payload.componentIssueMovementId, component]
  );
  const fgCostRes = await db.query(
    `SELECT COALESCE(SUM(COALESCE(extended_cost, 0)), 0)::numeric AS total_fg_cost
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
        AND item_id = $3
        AND COALESCE(quantity_delta_canonical, quantity_delta) > 0`,
    [tenantId, postRes.payload.productionReceiptMovementId, outputItem]
  );
  const issueCost = Number(issueCostRes.rows[0].total_issue_cost);
  const fgCost = Number(fgCostRes.rows[0].total_fg_cost);
  assert.ok(Math.abs(issueCost - 220) < 1e-6, `expected issue cost 220; got ${issueCost}`);
  assert.ok(Math.abs(fgCost - 220) < 1e-6, `expected FG cost 220; got ${fgCost}`);

  await runStrictInvariantsForTenant(tenantId);
});

test('report-production fails loud on insufficient component stock with no partial posting', async () => {
  const tenantSlug = `wo-report-insufficient-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'WO Report Production Insufficient Tenant'
  });
  const token = session.accessToken;
  const db = session.pool;
  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:insufficient` });
  const vendorId = await createVendor(token);

  const component = await createItem(token, defaults.SELLABLE.id, 'INSUFF-RAW', 'raw');
  const outputItem = await createItem(token, defaults.QA.id, 'INSUFF-FG', 'finished');
  const receiptLine = await createReceipt({
    token,
    vendorId,
    itemId: component,
    locationId: defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 4,
    keySuffix: tenantSlug
  });
  await qcAcceptReceiptLine(token, receiptLine, 5);
  const bomId = await createBom(token, outputItem, [{ componentItemId: component, quantityPer: 2 }], tenantSlug);
  const workOrder = await createWorkOrder(token, {
    kind: 'production',
    outputItemId: outputItem,
    outputUom: 'each',
    quantityPlanned: 10,
    bomId,
    defaultConsumeLocationId: defaults.SELLABLE.id,
    defaultProduceLocationId: defaults.QA.id
  });

  const res = await apiRequest('POST', `/work-orders/${workOrder.id}/report-production`, {
    token,
    headers: { 'Idempotency-Key': `wo-report-insuff:${tenantSlug}` },
    body: {
      warehouseId: warehouse.id,
      outputQty: 10,
      outputUom: 'each',
      occurredAt: '2026-02-11T00:00:00.000Z'
    }
  });
  assert.equal(res.res.status, 409, JSON.stringify(res.payload));
  assert.equal(res.payload?.error?.code, 'INSUFFICIENT_STOCK');

  const executionRes = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM work_order_executions
      WHERE work_order_id = $1`,
    [workOrder.id]
  );
  assert.equal(Number(executionRes.rows[0].count), 0);
});

test('concurrent report-production calls on shared component do not oversell', { timeout: 240000 }, async () => {
  const tenantSlug = `wo-report-race-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'WO Report Production Race Tenant'
  });
  const token = session.accessToken;
  const db = session.pool;
  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:race` });
  const vendorId = await createVendor(token);

  const component = await createItem(token, defaults.SELLABLE.id, 'RACE-RAW', 'raw');
  const outputA = await createItem(token, defaults.QA.id, 'RACE-FG-A', 'finished');
  const outputB = await createItem(token, defaults.QA.id, 'RACE-FG-B', 'finished');
  const receiptLine = await createReceipt({
    token,
    vendorId,
    itemId: component,
    locationId: defaults.SELLABLE.id,
    quantity: 30,
    unitCost: 6,
    keySuffix: tenantSlug
  });
  await qcAcceptReceiptLine(token, receiptLine, 30);

  const bomA = await createBom(token, outputA, [{ componentItemId: component, quantityPer: 20 }], `${tenantSlug}-a`);
  const bomB = await createBom(token, outputB, [{ componentItemId: component, quantityPer: 20 }], `${tenantSlug}-b`);
  const woA = await createWorkOrder(token, {
    kind: 'production',
    outputItemId: outputA,
    outputUom: 'each',
    quantityPlanned: 1,
    bomId: bomA,
    defaultConsumeLocationId: defaults.SELLABLE.id,
    defaultProduceLocationId: defaults.QA.id
  });
  const woB = await createWorkOrder(token, {
    kind: 'production',
    outputItemId: outputB,
    outputUom: 'each',
    quantityPlanned: 1,
    bomId: bomB,
    defaultConsumeLocationId: defaults.SELLABLE.id,
    defaultProduceLocationId: defaults.QA.id
  });

  const [aRes, bRes] = await Promise.all([
    apiRequest('POST', `/work-orders/${woA.id}/report-production`, {
      token,
      headers: { 'Idempotency-Key': `wo-report-race:${tenantSlug}:a` },
      body: { warehouseId: warehouse.id, outputQty: 1, outputUom: 'each', occurredAt: '2026-02-12T00:00:00.000Z' }
    }),
    apiRequest('POST', `/work-orders/${woB.id}/report-production`, {
      token,
      headers: { 'Idempotency-Key': `wo-report-race:${tenantSlug}:b` },
      body: { warehouseId: warehouse.id, outputQty: 1, outputUom: 'each', occurredAt: '2026-02-12T00:00:00.000Z' }
    })
  ]);

  const successCount = Number(aRes.res.status >= 200 && aRes.res.status < 300) + Number(bRes.res.status >= 200 && bRes.res.status < 300);
  assert.equal(successCount, 1, `expected one success; got a=${aRes.res.status} b=${bRes.res.status}`);

  const failed = aRes.res.status >= 400 ? aRes : bRes;
  assert.equal(failed.res.status, 409, JSON.stringify(failed.payload));
  assert.equal(failed.payload?.error?.code, 'INSUFFICIENT_STOCK');

  const onHandRes = await db.query(
    `SELECT COALESCE(SUM(on_hand), 0)::numeric AS on_hand
       FROM inventory_balance
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3`,
    [session.tenant.id, component, defaults.SELLABLE.id]
  );
  assert.ok(Number(onHandRes.rows[0].on_hand) >= 0, `component on_hand=${onHandRes.rows[0].on_hand}`);

  await runStrictInvariantsForTenant(session.tenant.id);
});

test('report-production fails loud when SELLABLE default points to a non-sellable location', async () => {
  const tenantSlug = `wo-report-no-line-side-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'WO Report Production No Line Side Policy Tenant'
  });
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  const { warehouse, defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:no-line-side` });

  const component = await createItem(token, defaults.SELLABLE.id, 'NOLS-RAW', 'raw');
  const outputItem = await createItem(token, defaults.QA.id, 'NOLS-FG', 'finished');
  const bomId = await createBom(token, outputItem, [{ componentItemId: component, quantityPer: 1 }], tenantSlug);
  const workOrder = await createWorkOrder(token, {
    kind: 'production',
    outputItemId: outputItem,
    outputUom: 'each',
    quantityPlanned: 1,
    bomId,
    defaultConsumeLocationId: defaults.SELLABLE.id,
    defaultProduceLocationId: defaults.QA.id
  });

  const nonSellableLocationRes = await apiRequest('POST', '/locations', {
    token,
    body: {
      code: `NOLS-HOLD-${randomUUID().slice(0, 8)}`,
      name: 'No Line Side Hold Source',
      type: 'bin',
      role: 'HOLD',
      isSellable: false,
      parentLocationId: warehouse.id,
      active: true
    }
  });
  assert.equal(nonSellableLocationRes.res.status, 201, JSON.stringify(nonSellableLocationRes.payload));

  const remapRes = await db.query(
    `UPDATE warehouse_default_location
        SET location_id = $3
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND role = 'SELLABLE'`,
    [tenantId, warehouse.id, nonSellableLocationRes.payload.id]
  );
  assert.equal(remapRes.rowCount, 1, 'expected SELLABLE default remap to HOLD for policy test');

  const reportRes = await apiRequest('POST', `/work-orders/${workOrder.id}/report-production`, {
    token,
    headers: { 'Idempotency-Key': `wo-report-no-line-side:${tenantSlug}` },
    body: {
      warehouseId: warehouse.id,
      outputQty: 1,
      outputUom: 'each',
      occurredAt: '2026-02-13T00:00:00.000Z'
    }
  });
  assert.equal(reportRes.res.status, 409, JSON.stringify(reportRes.payload));
  assert.equal(reportRes.payload?.error?.code, 'MANUFACTURING_CONSUMPTION_MUST_BE_SELLABLE');

  const executionRes = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM work_order_executions
      WHERE tenant_id = $1
        AND work_order_id = $2`,
    [tenantId, workOrder.id]
  );
  assert.equal(Number(executionRes.rows[0].count), 0, 'no execution should be posted when consumption source is non-sellable');
});

test('line-side/staging roles are rejected by master-data capability guards', async () => {
  const tenantSlug = `wo-report-no-line-side-capability-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'WO Report Production No Line Side Capability Tenant'
  });
  const token = session.accessToken;
  const { warehouse } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:no-line-side-capability` });

  const invalidRoles = ['LINE_SIDE', 'PROD_STAGING'];

  for (const role of invalidRoles) {
    const code = `NOLS-${role}-${randomUUID().slice(0, 6)}`;
    const res = await apiRequest('POST', '/locations', {
      token,
      body: {
        code,
        name: `No Line Side ${role}`,
        type: 'bin',
        role,
        isSellable: false,
        parentLocationId: warehouse.id,
        active: true
      }
    });
    assert.equal(res.res.status, 400, `expected role ${role} to be rejected, got ${res.res.status} body=${JSON.stringify(res.payload)}`);
  }
});
