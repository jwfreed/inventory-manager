import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `work-order-cost-${randomUUID().slice(0, 8)}`;

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

async function getSession() {
  return ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Work Order Cost Integrity Tenant'
  });
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

async function createItem(token, defaultLocationId, skuPrefix, options = {}) {
  const sku = `${skuPrefix}-${randomUUID().slice(0, 8)}`;
  const uomDimension = options.uomDimension ?? 'count';
  const canonicalUom = options.canonicalUom ?? 'each';
  const defaultUom = options.defaultUom ?? canonicalUom;
  const stockingUom = options.stockingUom ?? canonicalUom;
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      type: 'finished',
      defaultUom,
      uomDimension,
      canonicalUom,
      stockingUom,
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
  uom = 'each'
}) {
  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId: locationId,
      receivingLocationId: locationId,
      expectedDate: new Date().toISOString().slice(0, 10),
      status: 'approved',
      lines: [{ itemId, uom, quantityOrdered: quantity, unitCost, currencyCode: 'THB' }]
    }
  });
  assert.equal(poRes.res.status, 201, JSON.stringify(poRes.payload));

  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `wo-receipt-${randomUUID()}` },
    body: {
      purchaseOrderId: poRes.payload.id,
      receivedAt: new Date().toISOString(),
      lines: [
        {
          purchaseOrderLineId: poRes.payload.lines[0].id,
          uom,
          quantityReceived: quantity,
          unitCost
        }
      ]
    }
  });
  assert.equal(receiptRes.res.status, 201, JSON.stringify(receiptRes.payload));
  return receiptRes.payload;
}

async function qcAccept(token, receiptLineId, quantity, actorId, uom = 'each') {
  const res = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': `wo-qc-${randomUUID()}` },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity,
      uom,
      actorType: 'user',
      actorId
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
}

async function createDisassemblyWorkOrder(token, { outputItemId, quantityPlanned, outputUom = 'each' }) {
  const res = await apiRequest('POST', '/work-orders', {
    token,
    body: {
      kind: 'disassembly',
      outputItemId,
      outputUom,
      quantityPlanned
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createWorkOrderIssueDraft(
  token,
  workOrderId,
  { componentItemId, fromLocationId, quantityIssued, uom = 'each' }
) {
  const res = await apiRequest('POST', `/work-orders/${workOrderId}/issues`, {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      lines: [
        {
          componentItemId,
          fromLocationId,
          uom,
          quantityIssued
        }
      ]
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function postWorkOrderIssueDraft(token, workOrderId, issueId) {
  const res = await apiRequest('POST', `/work-orders/${workOrderId}/issues/${issueId}/post`, {
    token,
    body: {}
  });
  assert.equal(res.res.status, 200, JSON.stringify(res.payload));
  return res.payload;
}

async function createWorkOrderCompletionDraft(
  token,
  workOrderId,
  { outputItemId, toLocationId, quantityCompleted, uom = 'each' }
) {
  const res = await apiRequest('POST', `/work-orders/${workOrderId}/completions`, {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      lines: [
        {
          outputItemId,
          toLocationId,
          uom,
          quantityCompleted
        }
      ]
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function postWorkOrderCompletionDraft(token, workOrderId, completionId) {
  return apiRequest('POST', `/work-orders/${workOrderId}/completions/${completionId}/post`, {
    token,
    body: {}
  });
}

async function recordBatch(
  token,
  workOrderId,
  {
    consumeItemId,
    consumeLocationId,
    consumeQty,
    consumeUom = 'each',
    produceLines,
    headers,
    occurredAt = new Date().toISOString()
  }
) {
  return apiRequest('POST', `/work-orders/${workOrderId}/record-batch`, {
    token,
    headers,
    body: {
      occurredAt,
      consumeLines: [
        {
          componentItemId: consumeItemId,
          fromLocationId: consumeLocationId,
          uom: consumeUom,
          quantity: consumeQty
        }
      ],
      produceLines
    }
  });
}

async function loadExecutionConservation(db, tenantId, productionMovementId) {
  const execRes = await db.query(
    `SELECT id
       FROM work_order_executions
      WHERE tenant_id = $1
        AND production_movement_id = $2`,
    [tenantId, productionMovementId]
  );
  assert.equal(execRes.rowCount, 1);
  const executionId = execRes.rows[0].id;

  const compRes = await db.query(
    `SELECT COALESCE(SUM(extended_cost), 0)::numeric AS total_component_cost
       FROM cost_layer_consumptions
      WHERE tenant_id = $1
        AND wip_execution_id = $2
        AND consumption_type = 'production_input'`,
    [tenantId, executionId]
  );

  const moveRes = await db.query(
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

  const componentCost = Number(compRes.rows[0].total_component_cost);
  const fgCost = Number(moveRes.rows[0].total_fg_cost);
  const scrapCost = Number(moveRes.rows[0].scrap_cost);
  return {
    executionId,
    componentCost,
    fgCost,
    scrapCost,
    difference: componentCost - fgCost - scrapCost
  };
}

async function loadWorkOrderCostDriftCount(db, tenantId) {
  const driftRes = await db.query(
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
  return Number(driftRes.rows[0]?.count ?? 0);
}

test('simple production batch conserves value from consumed components to FG layers', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  const actorId = session.user?.id ?? null;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const sellable = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const componentItemId = await createItem(token, sellable.id, 'WO-COMP');
  const fgItemId = await createItem(token, sellable.id, 'WO-FG');
  const receipt = await createReceipt({
    token,
    vendorId,
    itemId: componentItemId,
    locationId: sellable.id,
    quantity: 5,
    unitCost: 10
  });
  await qcAccept(token, receipt.lines[0].id, 5, actorId);

  const workOrderId = await createDisassemblyWorkOrder(token, {
    outputItemId: componentItemId,
    quantityPlanned: 10
  });

  const batchRes = await recordBatch(token, workOrderId, {
    consumeItemId: componentItemId,
    consumeLocationId: sellable.id,
    consumeQty: 5,
    produceLines: [
      { outputItemId: fgItemId, toLocationId: sellable.id, uom: 'each', quantity: 5 }
    ]
  });
  assert.equal(batchRes.res.status, 201, JSON.stringify(batchRes.payload));

  const conservation = await loadExecutionConservation(db, tenantId, batchRes.payload.receiveMovementId);
  assert.ok(Math.abs(conservation.componentCost - 50) < 1e-6);
  assert.ok(Math.abs(conservation.fgCost - 50) < 1e-6);
  assert.ok(Math.abs(conservation.scrapCost) < 1e-6);
  assert.ok(Math.abs(conservation.difference) < 1e-6);
});

test('partial production across multiple batches preserves deterministic FIFO valuation', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  const actorId = session.user?.id ?? null;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:partial` });
  const sellable = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const componentItemId = await createItem(token, sellable.id, 'WO-PART-COMP');
  const fgItemId = await createItem(token, sellable.id, 'WO-PART-FG');
  const receipt = await createReceipt({
    token,
    vendorId,
    itemId: componentItemId,
    locationId: sellable.id,
    quantity: 7,
    unitCost: 4
  });
  await qcAccept(token, receipt.lines[0].id, 7, actorId);

  const workOrderId = await createDisassemblyWorkOrder(token, {
    outputItemId: componentItemId,
    quantityPlanned: 7
  });

  const batch1 = await recordBatch(token, workOrderId, {
    consumeItemId: componentItemId,
    consumeLocationId: sellable.id,
    consumeQty: 4,
    produceLines: [{ outputItemId: fgItemId, toLocationId: sellable.id, uom: 'each', quantity: 4 }]
  });
  assert.equal(batch1.res.status, 201, JSON.stringify(batch1.payload));

  const batch2 = await recordBatch(token, workOrderId, {
    consumeItemId: componentItemId,
    consumeLocationId: sellable.id,
    consumeQty: 3,
    produceLines: [{ outputItemId: fgItemId, toLocationId: sellable.id, uom: 'each', quantity: 3 }]
  });
  assert.equal(batch2.res.status, 201, JSON.stringify(batch2.payload));

  const cons1 = await loadExecutionConservation(db, tenantId, batch1.payload.receiveMovementId);
  const cons2 = await loadExecutionConservation(db, tenantId, batch2.payload.receiveMovementId);
  assert.ok(Math.abs(cons1.componentCost - 16) < 1e-6);
  assert.ok(Math.abs(cons1.fgCost - 16) < 1e-6);
  assert.ok(Math.abs(cons1.difference) < 1e-6);
  assert.ok(Math.abs(cons2.componentCost - 12) < 1e-6);
  assert.ok(Math.abs(cons2.fgCost - 12) < 1e-6);
  assert.ok(Math.abs(cons2.difference) < 1e-6);
});

test('scrap/reject production lines are explicitly valued in conservation math', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  const actorId = session.user?.id ?? null;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:scrap` });
  const sellable = defaults.SELLABLE;
  const scrap = defaults.SCRAP;

  const vendorId = await createVendor(token);
  const componentItemId = await createItem(token, sellable.id, 'WO-SCRAP-COMP');
  const fgItemId = await createItem(token, sellable.id, 'WO-SCRAP-FG');
  const receipt = await createReceipt({
    token,
    vendorId,
    itemId: componentItemId,
    locationId: sellable.id,
    quantity: 10,
    unitCost: 10
  });
  await qcAccept(token, receipt.lines[0].id, 10, actorId);

  const workOrderId = await createDisassemblyWorkOrder(token, {
    outputItemId: componentItemId,
    quantityPlanned: 10
  });

  const batch = await recordBatch(token, workOrderId, {
    consumeItemId: componentItemId,
    consumeLocationId: sellable.id,
    consumeQty: 10,
    produceLines: [
      { outputItemId: fgItemId, toLocationId: sellable.id, uom: 'each', quantity: 9 },
      {
        outputItemId: fgItemId,
        toLocationId: scrap.id,
        uom: 'each',
        quantity: 1,
        reasonCode: 'work_order_scrap'
      }
    ]
  });
  assert.equal(batch.res.status, 201, JSON.stringify(batch.payload));

  const conservation = await loadExecutionConservation(db, tenantId, batch.payload.receiveMovementId);
  assert.ok(Math.abs(conservation.componentCost - 100) < 1e-6);
  assert.ok(Math.abs(conservation.fgCost - 90) < 1e-6);
  assert.ok(Math.abs(conservation.scrapCost - 10) < 1e-6);
  assert.ok(Math.abs(conservation.difference) < 1e-6);
});

test('posting the same work-order completion twice is idempotent and does not double-consume', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  const actorId = session.user?.id ?? null;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:idempotent` });
  const sellable = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const componentItemId = await createItem(token, sellable.id, 'WO-IDEMP-COMP');
  const fgItemId = await createItem(token, sellable.id, 'WO-IDEMP-FG');
  const receipt = await createReceipt({
    token,
    vendorId,
    itemId: componentItemId,
    locationId: sellable.id,
    quantity: 5,
    unitCost: 9
  });
  await qcAccept(token, receipt.lines[0].id, 5, actorId);

  const workOrderId = await createDisassemblyWorkOrder(token, {
    outputItemId: componentItemId,
    quantityPlanned: 10
  });
  const issueId = await createWorkOrderIssueDraft(token, workOrderId, {
    componentItemId,
    fromLocationId: sellable.id,
    quantityIssued: 5
  });
  await postWorkOrderIssueDraft(token, workOrderId, issueId);

  const completionId = await createWorkOrderCompletionDraft(token, workOrderId, {
    outputItemId: fgItemId,
    toLocationId: sellable.id,
    quantityCompleted: 5
  });

  const [postA, postB] = await Promise.all([
    postWorkOrderCompletionDraft(token, workOrderId, completionId),
    postWorkOrderCompletionDraft(token, workOrderId, completionId)
  ]);
  assert.equal(postA.res.status, 200, JSON.stringify(postA.payload));
  assert.equal(postB.res.status, 200, JSON.stringify(postB.payload));

  const movementRes = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = 'work_order_completion_post'
        AND source_id = $2`,
    [tenantId, completionId]
  );
  assert.equal(Number(movementRes.rows[0].count), 1);

  const completionRes = await db.query(
    `SELECT production_movement_id
       FROM work_order_executions
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, completionId]
  );
  assert.equal(completionRes.rowCount, 1);
  const productionMovementId = completionRes.rows[0].production_movement_id;
  assert.ok(productionMovementId);

  const movementLineRes = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2`,
    [tenantId, productionMovementId]
  );
  assert.equal(Number(movementLineRes.rows[0].count), 1);

  const allocatedRes = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM cost_layer_consumptions
      WHERE tenant_id = $1
        AND wip_execution_id = $2`,
    [tenantId, completionId]
  );
  assert.equal(Number(allocatedRes.rows[0].count), 1);
});

test('record-batch idempotency key prevents duplicate inventory and cost posting', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  const actorId = session.user?.id ?? null;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:batch-idempotent` });
  const sellable = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const componentItemId = await createItem(token, sellable.id, 'WO-BATCH-IDEMP-COMP');
  const fgItemId = await createItem(token, sellable.id, 'WO-BATCH-IDEMP-FG');
  const receipt = await createReceipt({
    token,
    vendorId,
    itemId: componentItemId,
    locationId: sellable.id,
    quantity: 6,
    unitCost: 5
  });
  await qcAccept(token, receipt.lines[0].id, 6, actorId);

  const workOrderId = await createDisassemblyWorkOrder(token, {
    outputItemId: componentItemId,
    quantityPlanned: 6
  });
  const idempotencyKey = `wo-batch-idem-${randomUUID()}`;
  const occurredAt = new Date().toISOString();
  const requestBody = {
    consumeItemId: componentItemId,
    consumeLocationId: sellable.id,
    consumeQty: 6,
    produceLines: [{ outputItemId: fgItemId, toLocationId: sellable.id, uom: 'each', quantity: 6 }],
    headers: { 'Idempotency-Key': idempotencyKey },
    occurredAt
  };

  const first = await recordBatch(token, workOrderId, requestBody);
  assert.equal(first.res.status, 201, JSON.stringify(first.payload));
  const second = await recordBatch(token, workOrderId, requestBody);
  assert.equal(second.res.status, 201, JSON.stringify(second.payload));
  assert.equal(first.payload.issueMovementId, second.payload.issueMovementId);
  assert.equal(first.payload.receiveMovementId, second.payload.receiveMovementId);

  const executionRes = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM work_order_executions
      WHERE tenant_id = $1
        AND idempotency_key = $2`,
    [tenantId, idempotencyKey]
  );
  assert.equal(Number(executionRes.rows[0].count), 1);

  const movementRes = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND idempotency_key IN ($2, $3)`,
    [tenantId, `${idempotencyKey}:issue`, `${idempotencyKey}:completion`]
  );
  assert.equal(Number(movementRes.rows[0].count), 2);
});

test('record-batch idempotency key rejects payload mismatches with deterministic conflict code', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const actorId = session.user?.id ?? null;
  const { defaults } = await ensureStandardWarehouse({
    token,
    apiRequest,
    scope: `${import.meta.url}:batch-idempotency-conflict`
  });
  const sellable = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const componentItemId = await createItem(token, sellable.id, 'WO-BATCH-CONFLICT-COMP');
  const fgItemId = await createItem(token, sellable.id, 'WO-BATCH-CONFLICT-FG');
  const receipt = await createReceipt({
    token,
    vendorId,
    itemId: componentItemId,
    locationId: sellable.id,
    quantity: 8,
    unitCost: 4
  });
  await qcAccept(token, receipt.lines[0].id, 8, actorId);

  const workOrderId = await createDisassemblyWorkOrder(token, {
    outputItemId: componentItemId,
    quantityPlanned: 8
  });
  const idempotencyKey = `wo-batch-idem-conflict-${randomUUID()}`;
  const occurredAt = new Date().toISOString();

  const first = await recordBatch(token, workOrderId, {
    consumeItemId: componentItemId,
    consumeLocationId: sellable.id,
    consumeQty: 8,
    produceLines: [{ outputItemId: fgItemId, toLocationId: sellable.id, uom: 'each', quantity: 8 }],
    headers: { 'Idempotency-Key': idempotencyKey },
    occurredAt
  });
  assert.equal(first.res.status, 201, JSON.stringify(first.payload));

  const second = await recordBatch(token, workOrderId, {
    consumeItemId: componentItemId,
    consumeLocationId: sellable.id,
    consumeQty: 8,
    produceLines: [{ outputItemId: fgItemId, toLocationId: sellable.id, uom: 'each', quantity: 7 }],
    headers: { 'Idempotency-Key': idempotencyKey },
    occurredAt
  });
  assert.equal(second.res.status, 409, JSON.stringify(second.payload));
  assert.equal(second.payload?.error?.code, 'WO_POSTING_IDEMPOTENCY_CONFLICT');
});

test('record-batch idempotency key reports incomplete executions with missing ids', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  const actorId = session.user?.id ?? null;
  const { defaults } = await ensureStandardWarehouse({
    token,
    apiRequest,
    scope: `${import.meta.url}:batch-idempotency-incomplete`
  });
  const sellable = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const componentItemId = await createItem(token, sellable.id, 'WO-BATCH-INCOMPLETE-COMP');
  const fgItemId = await createItem(token, sellable.id, 'WO-BATCH-INCOMPLETE-FG');
  const receipt = await createReceipt({
    token,
    vendorId,
    itemId: componentItemId,
    locationId: sellable.id,
    quantity: 6,
    unitCost: 3
  });
  await qcAccept(token, receipt.lines[0].id, 6, actorId);

  const workOrderId = await createDisassemblyWorkOrder(token, {
    outputItemId: componentItemId,
    quantityPlanned: 6
  });
  const idempotencyKey = `wo-batch-idem-incomplete-${randomUUID()}`;
  const occurredAt = new Date().toISOString();

  const first = await recordBatch(token, workOrderId, {
    consumeItemId: componentItemId,
    consumeLocationId: sellable.id,
    consumeQty: 6,
    produceLines: [{ outputItemId: fgItemId, toLocationId: sellable.id, uom: 'each', quantity: 6 }],
    headers: { 'Idempotency-Key': idempotencyKey },
    occurredAt
  });
  assert.equal(first.res.status, 201, JSON.stringify(first.payload));

  const executionRes = await db.query(
    `SELECT id
       FROM work_order_executions
      WHERE tenant_id = $1
        AND idempotency_key = $2`,
    [tenantId, idempotencyKey]
  );
  assert.equal(executionRes.rowCount, 1);
  const executionId = executionRes.rows[0].id;

  await db.query(
    `UPDATE work_order_executions
        SET status = 'draft'
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, executionId]
  );

  const second = await recordBatch(token, workOrderId, {
    consumeItemId: componentItemId,
    consumeLocationId: sellable.id,
    consumeQty: 6,
    produceLines: [{ outputItemId: fgItemId, toLocationId: sellable.id, uom: 'each', quantity: 6 }],
    headers: { 'Idempotency-Key': idempotencyKey },
    occurredAt
  });
  assert.equal(second.res.status, 409, JSON.stringify(second.payload));
  assert.equal(second.payload?.error?.code, 'WO_POSTING_IDEMPOTENCY_INCOMPLETE');
  assert.deepEqual(second.payload?.error?.details?.missingExecutionIds, [executionId]);
});

test('yield transformation without explicit scrap conserves value by increasing FG unit cost', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  const actorId = session.user?.id ?? null;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:yield` });
  const sellable = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const componentItemId = await createItem(token, sellable.id, 'WO-YIELD-COMP');
  const fgItemId = await createItem(token, sellable.id, 'WO-YIELD-FG');
  const receipt = await createReceipt({
    token,
    vendorId,
    itemId: componentItemId,
    locationId: sellable.id,
    quantity: 10,
    unitCost: 10
  });
  await qcAccept(token, receipt.lines[0].id, 10, actorId);

  const workOrderId = await createDisassemblyWorkOrder(token, {
    outputItemId: componentItemId,
    quantityPlanned: 10
  });
  const batchRes = await recordBatch(token, workOrderId, {
    consumeItemId: componentItemId,
    consumeLocationId: sellable.id,
    consumeQty: 10,
    produceLines: [{ outputItemId: fgItemId, toLocationId: sellable.id, uom: 'each', quantity: 8 }]
  });
  assert.equal(batchRes.res.status, 201, JSON.stringify(batchRes.payload));

  const conservation = await loadExecutionConservation(db, tenantId, batchRes.payload.receiveMovementId);
  assert.ok(Math.abs(conservation.componentCost - 100) < 1e-6);
  assert.ok(Math.abs(conservation.fgCost - 100) < 1e-6);
  assert.ok(Math.abs(conservation.scrapCost) < 1e-6);
  assert.ok(Math.abs(conservation.difference) < 1e-6);

  const fgLineRes = await db.query(
    `SELECT unit_cost
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
        AND COALESCE(quantity_delta_canonical, quantity_delta) > 0
      LIMIT 1`,
    [tenantId, batchRes.payload.receiveMovementId]
  );
  assert.equal(fgLineRes.rowCount, 1);
  assert.ok(Math.abs(Number(fgLineRes.rows[0].unit_cost) - 12.5) < 1e-6);
});

test('fractional production quantities are stable within conservation epsilon', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  const actorId = session.user?.id ?? null;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:rounding` });
  const sellable = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const fgItemId = await createItem(token, sellable.id, 'WO-ROUND-FG', {
    uomDimension: 'mass',
    canonicalUom: 'g',
    defaultUom: 'g',
    stockingUom: 'g'
  });
  const fractionalComponentItemId = await createItem(token, sellable.id, 'WO-ROUND-COMP-MASS', {
    uomDimension: 'mass',
    canonicalUom: 'g',
    defaultUom: 'g',
    stockingUom: 'g'
  });
  const receipt = await createReceipt({
    token,
    vendorId,
    itemId: fractionalComponentItemId,
    locationId: sellable.id,
    quantity: 1,
    unitCost: 1,
    uom: 'g'
  });
  await qcAccept(token, receipt.lines[0].id, 1, actorId, 'g');

  const workOrderId = await createDisassemblyWorkOrder(token, {
    outputItemId: fractionalComponentItemId,
    quantityPlanned: 1,
    outputUom: 'g'
  });
  const batchRes = await recordBatch(token, workOrderId, {
    consumeItemId: fractionalComponentItemId,
    consumeLocationId: sellable.id,
    consumeQty: 1,
    consumeUom: 'g',
    produceLines: [
      { outputItemId: fgItemId, toLocationId: sellable.id, uom: 'g', quantity: 0.333333 },
      { outputItemId: fgItemId, toLocationId: sellable.id, uom: 'g', quantity: 0.333333 },
      { outputItemId: fgItemId, toLocationId: sellable.id, uom: 'g', quantity: 0.333333 }
    ]
  });
  assert.equal(batchRes.res.status, 201, JSON.stringify(batchRes.payload));

  const conservation = await loadExecutionConservation(db, tenantId, batchRes.payload.receiveMovementId);
  const roundedDiff = Math.abs(Number(conservation.difference.toFixed(6)));
  assert.ok(roundedDiff <= 1e-6, `expected <= 1e-6 drift, got ${conservation.difference}`);

  const driftCount = await loadWorkOrderCostDriftCount(db, tenantId);
  assert.equal(driftCount, 0);
});

test('concurrent work-order postings cannot over-consume the same FIFO layer set', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant.id;
  const db = session.pool;
  const actorId = session.user?.id ?? null;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:race` });
  const sellable = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const componentItemId = await createItem(token, sellable.id, 'WO-RACE-COMP');
  const fgItemId = await createItem(token, sellable.id, 'WO-RACE-FG');
  const receipt = await createReceipt({
    token,
    vendorId,
    itemId: componentItemId,
    locationId: sellable.id,
    quantity: 5,
    unitCost: 7
  });
  await qcAccept(token, receipt.lines[0].id, 5, actorId);

  const workOrderA = await createDisassemblyWorkOrder(token, {
    outputItemId: componentItemId,
    quantityPlanned: 5
  });
  const workOrderB = await createDisassemblyWorkOrder(token, {
    outputItemId: componentItemId,
    quantityPlanned: 5
  });

  const requestBody = {
    consumeItemId: componentItemId,
    consumeLocationId: sellable.id,
    consumeQty: 5,
    produceLines: [{ outputItemId: fgItemId, toLocationId: sellable.id, uom: 'each', quantity: 5 }]
  };
  const [aRes, bRes] = await Promise.all([
    recordBatch(token, workOrderA, requestBody),
    recordBatch(token, workOrderB, requestBody)
  ]);

  const statuses = [aRes.res.status, bRes.res.status].sort();
  assert.deepEqual(statuses, [201, 409], `expected one success and one conflict: ${JSON.stringify([aRes.payload, bRes.payload])}`);

  const consumedRes = await db.query(
    `SELECT COALESCE(SUM(consumed_quantity), 0)::numeric AS consumed_qty
       FROM cost_layer_consumptions
      WHERE tenant_id = $1
        AND consumption_type = 'production_input'
        AND movement_id IN ($2::uuid, $3::uuid)`,
    [tenantId, aRes.payload?.issueMovementId ?? randomUUID(), bRes.payload?.issueMovementId ?? randomUUID()]
  );
  const consumedQty = Number(consumedRes.rows[0].consumed_qty);
  assert.ok(consumedQty <= 5.000001, `expected consumed qty <= 5, got ${consumedQty}`);
});

test('work-order reversal is explicitly blocked', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:reverse` });
  const sellable = defaults.SELLABLE;

  const componentItemId = await createItem(token, sellable.id, 'WO-REV-COMP');
  const workOrderId = await createDisassemblyWorkOrder(token, {
    outputItemId: componentItemId,
    quantityPlanned: 1
  });

  const reverseRes = await apiRequest('POST', `/work-orders/${workOrderId}/reverse`, { token, body: {} });
  assert.equal(reverseRes.res.status, 409);
  assert.equal(reverseRes.payload?.error?.code, 'WORK_ORDER_REVERSAL_NOT_SUPPORTED');
});
