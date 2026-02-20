import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `retail-dist-${randomUUID().slice(0, 8)}`;

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
    tenantName: 'Retail Distribution Flow Tenant'
  });
}

async function createWarehouseWithSellable(token, codePrefix) {
  const warehouseRes = await apiRequest('POST', '/locations', {
    token,
    body: {
      code: `${codePrefix}-WH`,
      name: `${codePrefix} Warehouse`,
      type: 'warehouse',
      active: true
    }
  });
  assert.equal(warehouseRes.res.status, 201, JSON.stringify(warehouseRes.payload));

  const sellableRes = await apiRequest('POST', '/locations', {
    token,
    body: {
      code: `${codePrefix}-SELLABLE`,
      name: `${codePrefix} Sellable`,
      type: 'bin',
      role: 'SELLABLE',
      isSellable: true,
      active: true,
      parentLocationId: warehouseRes.payload.id
    }
  });
  assert.equal(sellableRes.res.status, 201, JSON.stringify(sellableRes.payload));
  return { warehouse: warehouseRes.payload, sellable: sellableRes.payload };
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

async function createItem(token, defaultLocationId, skuPrefix) {
  const sku = `${skuPrefix}-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      type: 'finished',
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

async function createReceipt({ token, vendorId, itemId, locationId, quantity, unitCost }) {
  const poRes = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId: locationId,
      receivingLocationId: locationId,
      expectedDate: new Date().toISOString().slice(0, 10),
      status: 'approved',
      lines: [{ itemId, uom: 'each', quantityOrdered: quantity, unitCost, currencyCode: 'THB' }]
    }
  });
  assert.equal(poRes.res.status, 201, JSON.stringify(poRes.payload));

  const receiptRes = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `retail-receipt-${randomUUID()}` },
    body: {
      purchaseOrderId: poRes.payload.id,
      receivedAt: new Date().toISOString(),
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

async function qcAccept(token, body) {
  const res = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': `retail-qc-${randomUUID()}` },
    body
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload;
}

async function getAtpAvailable(token, warehouseId, itemId) {
  const res = await apiRequest('GET', '/atp', {
    token,
    params: { warehouseId, itemId }
  });
  assert.equal(res.res.status, 200, JSON.stringify(res.payload));
  return (res.payload?.data || []).reduce((sum, row) => sum + Number(row.availableToPromise || 0), 0);
}

test('retail distribution flow: WO->QA, QC accept, transfer to store, reserve+fulfill store scoped', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const db = session.pool;
  const tenantId = session.tenant.id;
  const actorId = session.user?.id ?? null;

  const factory = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const store = await createWarehouseWithSellable(token, `STORE-${randomUUID().slice(0, 6)}`);

  const componentItemId = await createItem(token, factory.defaults.SELLABLE.id, 'COMP');
  const fgItemId = await createItem(token, factory.defaults.SELLABLE.id, 'FG');
  const vendorId = await createVendor(token);

  const receiptLineId = await createReceipt({
    token,
    vendorId,
    itemId: componentItemId,
    locationId: factory.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 7
  });
  await qcAccept(token, {
    purchaseOrderReceiptLineId: receiptLineId,
    eventType: 'accept',
    quantity: 10,
    uom: 'each',
    actorType: 'user',
    actorId
  });

  const woRes = await apiRequest('POST', '/work-orders', {
    token,
    body: {
      kind: 'disassembly',
      outputItemId: componentItemId,
      outputUom: 'each',
      quantityPlanned: 10,
      defaultConsumeLocationId: factory.defaults.SELLABLE.id,
      defaultProduceLocationId: factory.defaults.QA.id
    }
  });
  assert.equal(woRes.res.status, 201, JSON.stringify(woRes.payload));

  const batchRes = await apiRequest('POST', `/work-orders/${woRes.payload.id}/record-batch`, {
    token,
    headers: { 'Idempotency-Key': `retail-wo-${randomUUID()}` },
    body: {
      occurredAt: new Date().toISOString(),
      consumeLines: [
        {
          componentItemId,
          fromLocationId: factory.defaults.SELLABLE.id,
          uom: 'each',
          quantity: 10
        }
      ],
      produceLines: [
        {
          outputItemId: fgItemId,
          toLocationId: factory.defaults.QA.id,
          uom: 'each',
          quantity: 10
        }
      ]
    }
  });
  assert.equal(batchRes.res.status, 201, JSON.stringify(batchRes.payload));

  const qaReserveRes = await apiRequest('POST', '/reservations', {
    token,
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId: fgItemId,
          warehouseId: factory.warehouse.id,
          locationId: factory.defaults.QA.id,
          uom: 'each',
          quantityReserved: 1
        }
      ]
    }
  });
  assert.equal(qaReserveRes.res.status, 409, JSON.stringify(qaReserveRes.payload));
  assert.equal(qaReserveRes.payload?.error?.code, 'NON_SELLABLE_LOCATION');

  const executionLineRes = await db.query(
    `SELECT wel.id
       FROM work_order_executions we
       JOIN work_order_execution_lines wel
         ON wel.work_order_execution_id = we.id
        AND wel.tenant_id = we.tenant_id
      WHERE we.tenant_id = $1
        AND we.production_movement_id = $2
        AND wel.line_type = 'produce'
        AND wel.item_id = $3
      ORDER BY wel.created_at ASC
      LIMIT 1`,
    [tenantId, batchRes.payload.receiveMovementId, fgItemId]
  );
  assert.equal(executionLineRes.rowCount, 1);
  const executionLineId = executionLineRes.rows[0].id;

  await qcAccept(token, {
    workOrderExecutionLineId: executionLineId,
    eventType: 'accept',
    quantity: 10,
    uom: 'each',
    actorType: 'user',
    actorId
  });

  const factoryBeforeTransfer = await getAtpAvailable(token, factory.warehouse.id, fgItemId);
  assert.ok(Math.abs(factoryBeforeTransfer - 10) < 1e-6, `factory ATP before transfer=${factoryBeforeTransfer}`);

  const transferRes = await apiRequest('POST', '/inventory-transfers', {
    token,
    headers: { 'Idempotency-Key': `retail-transfer-${randomUUID()}` },
    body: {
      sourceLocationId: factory.defaults.SELLABLE.id,
      destinationLocationId: store.sellable.id,
      itemId: fgItemId,
      quantity: 6,
      uom: 'each',
      reasonCode: 'retail_distribution',
      notes: 'Factory to store distribution'
    }
  });
  assert.equal(transferRes.res.status, 201, JSON.stringify(transferRes.payload));
  const transferMovementId = transferRes.payload.movementId;

  const transferCostRes = await db.query(
    `SELECT COALESCE(SUM(quantity * unit_cost), 0)::numeric AS total_value
       FROM cost_layer_transfer_links
      WHERE tenant_id = $1
        AND transfer_movement_id = $2`,
    [tenantId, transferMovementId]
  );
  assert.ok(Math.abs(Number(transferCostRes.rows[0].total_value) - 42) < 1e-6);

  const factoryAfterTransfer = await getAtpAvailable(token, factory.warehouse.id, fgItemId);
  const storeAfterTransfer = await getAtpAvailable(token, store.warehouse.id, fgItemId);
  assert.ok(Math.abs(factoryAfterTransfer - 4) < 1e-6, `factory ATP after transfer=${factoryAfterTransfer}`);
  assert.ok(Math.abs(storeAfterTransfer - 6) < 1e-6, `store ATP after transfer=${storeAfterTransfer}`);

  const customerId = randomUUID();
  await db.query(
    `INSERT INTO customers (id, tenant_id, code, name, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, now(), now())`,
    [customerId, tenantId, `C-${customerId.slice(0, 8)}`, `Customer ${customerId.slice(0, 6)}`]
  );

  const soRes = await apiRequest('POST', '/sales-orders', {
    token,
    body: {
      soNumber: `SO-${randomUUID().slice(0, 8)}`,
      customerId,
      status: 'submitted',
      warehouseId: store.warehouse.id,
      shipFromLocationId: store.sellable.id,
      lines: [{ itemId: fgItemId, uom: 'each', quantityOrdered: 4 }]
    }
  });
  assert.equal(soRes.res.status, 201, JSON.stringify(soRes.payload));
  const soLineId = soRes.payload.lines[0].id;

  const reserveRes = await apiRequest('POST', '/reservations', {
    token,
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: soLineId,
          itemId: fgItemId,
          warehouseId: store.warehouse.id,
          locationId: store.sellable.id,
          uom: 'each',
          quantityReserved: 4
        }
      ]
    }
  });
  assert.equal(reserveRes.res.status, 201, JSON.stringify(reserveRes.payload));

  const shipmentRes = await apiRequest('POST', '/shipments', {
    token,
    body: {
      salesOrderId: soRes.payload.id,
      shippedAt: new Date().toISOString(),
      shipFromLocationId: store.sellable.id,
      lines: [{ salesOrderLineId: soLineId, uom: 'each', quantityShipped: 4 }]
    }
  });
  assert.equal(shipmentRes.res.status, 201, JSON.stringify(shipmentRes.payload));

  const shipmentPost = await apiRequest('POST', `/shipments/${shipmentRes.payload.id}/post`, {
    token,
    headers: { 'Idempotency-Key': `retail-ship-${randomUUID()}` },
    body: {}
  });
  assert.equal(shipmentPost.res.status, 200, JSON.stringify(shipmentPost.payload));
  const shipmentMovementId = shipmentPost.payload.inventoryMovementId;
  assert.ok(shipmentMovementId);

  const shipmentCostRes = await db.query(
    `SELECT COALESCE(SUM(extended_cost), 0)::numeric AS total_cost
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2`,
    [tenantId, shipmentMovementId]
  );
  assert.ok(Math.abs(Number(shipmentCostRes.rows[0].total_cost) + 28) < 1e-6);

  const factoryAfterFulfill = await getAtpAvailable(token, factory.warehouse.id, fgItemId);
  const storeAfterFulfill = await getAtpAvailable(token, store.warehouse.id, fgItemId);
  assert.ok(Math.abs(factoryAfterFulfill - 4) < 1e-6, `factory ATP after fulfill=${factoryAfterFulfill}`);
  assert.ok(Math.abs(storeAfterFulfill - 2) < 1e-6, `store ATP after fulfill=${storeAfterFulfill}`);
});
