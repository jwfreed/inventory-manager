import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `so-wh-scope-${randomUUID().slice(0, 8)}`;

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
    tenantName: 'SO Warehouse Scope Tenant'
  });
}

async function createCustomer(db, tenantId) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO customers (id, tenant_id, code, name, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, now(), now())`,
    [id, tenantId, `CUST-${id.slice(0, 8)}`, `Customer ${id.slice(0, 6)}`]
  );
  return id;
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
    headers: { 'Idempotency-Key': `so-wh-rsv-receipt-${randomUUID()}` },
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

async function qcAccept(token, receiptLineId, quantity, actorId) {
  const res = await apiRequest('POST', '/qc-events', {
    token,
    headers: { 'Idempotency-Key': `so-wh-rsv-qc-${randomUUID()}` },
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity,
      uom: 'each',
      actorType: 'user',
      actorId
    }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
}

test('sales order creation requires warehouse scope', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const db = session.pool;
  const tenantId = session.tenant.id;
  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:required` });
  const customerId = await createCustomer(db, tenantId);
  const itemId = await createItem(token, defaults.SELLABLE.id, 'SO-WH-REQ');

  const soRes = await apiRequest('POST', '/sales-orders', {
    token,
    body: {
      soNumber: `SO-${randomUUID().slice(0, 8)}`,
      customerId,
      shipFromLocationId: defaults.SELLABLE.id,
      lines: [
        {
          lineNumber: 1,
          itemId,
          uom: 'each',
          quantityOrdered: 1
        }
      ]
    }
  });

  assert.equal(soRes.res.status, 400, JSON.stringify(soRes.payload));
  assert.equal(soRes.payload?.error?.code, 'WAREHOUSE_SCOPE_REQUIRED');
});

test('sales order rejects ship-from location outside warehouse scope', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const db = session.pool;
  const tenantId = session.tenant.id;
  const primary = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:mismatch` });
  const secondary = await createWarehouseWithSellable(token, `WH-${randomUUID().slice(0, 6)}`);
  const customerId = await createCustomer(db, tenantId);
  const itemId = await createItem(token, primary.defaults.SELLABLE.id, 'SO-WH-MM');

  const soRes = await apiRequest('POST', '/sales-orders', {
    token,
    body: {
      soNumber: `SO-${randomUUID().slice(0, 8)}`,
      customerId,
      warehouseId: primary.warehouse.id,
      shipFromLocationId: secondary.sellable.id,
      lines: [
        {
          lineNumber: 1,
          itemId,
          uom: 'each',
          quantityOrdered: 1
        }
      ]
    }
  });

  assert.equal(soRes.res.status, 409, JSON.stringify(soRes.payload));
  assert.equal(soRes.payload?.error?.code, 'WAREHOUSE_SCOPE_MISMATCH');
});

test('reservation rejects sales order line with mismatched warehouse scope', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const db = session.pool;
  const tenantId = session.tenant.id;
  const primary = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:reservation` });
  const secondary = await createWarehouseWithSellable(token, `WH-${randomUUID().slice(0, 6)}`);
  const customerId = await createCustomer(db, tenantId);
  const itemId = await createItem(token, primary.defaults.SELLABLE.id, 'SO-WH-RSV');

  const soRes = await apiRequest('POST', '/sales-orders', {
    token,
    body: {
      soNumber: `SO-${randomUUID().slice(0, 8)}`,
      customerId,
      warehouseId: primary.warehouse.id,
      shipFromLocationId: primary.defaults.SELLABLE.id,
      lines: [
        {
          lineNumber: 1,
          itemId,
          uom: 'each',
          quantityOrdered: 2
        }
      ]
    }
  });
  assert.equal(soRes.res.status, 201, JSON.stringify(soRes.payload));
  const soLineId = soRes.payload.lines[0].id;

  const reserveRes = await apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `reserve-${randomUUID()}` },
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: soLineId,
          itemId,
          warehouseId: secondary.warehouse.id,
          locationId: secondary.sellable.id,
          uom: 'each',
          quantityReserved: 1
        }
      ]
    }
  });

  assert.equal(reserveRes.res.status, 409, JSON.stringify(reserveRes.payload));
  assert.equal(reserveRes.payload?.error?.code, 'WAREHOUSE_SCOPE_MISMATCH');
});

test('reservation rejects redundant warehouseId when it does not match derived sales-order scope', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const db = session.pool;
  const tenantId = session.tenant.id;
  const primary = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:reservation-redundant` });
  const secondary = await createWarehouseWithSellable(token, `WH-${randomUUID().slice(0, 6)}`);
  const customerId = await createCustomer(db, tenantId);
  const itemId = await createItem(token, primary.defaults.SELLABLE.id, 'SO-WH-RSV-R');

  const soRes = await apiRequest('POST', '/sales-orders', {
    token,
    body: {
      soNumber: `SO-${randomUUID().slice(0, 8)}`,
      customerId,
      warehouseId: primary.warehouse.id,
      shipFromLocationId: primary.defaults.SELLABLE.id,
      lines: [
        {
          lineNumber: 1,
          itemId,
          uom: 'each',
          quantityOrdered: 1
        }
      ]
    }
  });
  assert.equal(soRes.res.status, 201, JSON.stringify(soRes.payload));
  const soLineId = soRes.payload.lines[0].id;

  const reserveRes = await apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `reserve-${randomUUID()}` },
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: soLineId,
          itemId,
          warehouseId: secondary.warehouse.id,
          locationId: primary.defaults.SELLABLE.id,
          uom: 'each',
          quantityReserved: 1
        }
      ]
    }
  });

  assert.equal(reserveRes.res.status, 409, JSON.stringify(reserveRes.payload));
  assert.equal(reserveRes.payload?.error?.code, 'WAREHOUSE_SCOPE_MISMATCH');
});

test('reservation derives warehouse scope from sales order when warehouseId is omitted', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const db = session.pool;
  const tenantId = session.tenant.id;
  const actorId = session.user?.id ?? null;
  const primary = await ensureStandardWarehouse({ token, apiRequest, scope: `${import.meta.url}:reservation-derived` });
  const customerId = await createCustomer(db, tenantId);
  const itemId = await createItem(token, primary.defaults.SELLABLE.id, 'SO-WH-RSV-D');
  const vendorId = await createVendor(token);
  const receiptLineId = await createReceipt({
    token,
    vendorId,
    itemId,
    locationId: primary.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 4
  });
  await qcAccept(token, receiptLineId, 5, actorId);

  const soRes = await apiRequest('POST', '/sales-orders', {
    token,
    body: {
      soNumber: `SO-${randomUUID().slice(0, 8)}`,
      customerId,
      warehouseId: primary.warehouse.id,
      shipFromLocationId: primary.defaults.SELLABLE.id,
      lines: [
        {
          lineNumber: 1,
          itemId,
          uom: 'each',
          quantityOrdered: 1
        }
      ]
    }
  });
  assert.equal(soRes.res.status, 201, JSON.stringify(soRes.payload));
  const soLineId = soRes.payload.lines[0].id;

  const reserveRes = await apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `reserve-${randomUUID()}` },
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: soLineId,
          itemId,
          locationId: primary.defaults.SELLABLE.id,
          uom: 'each',
          quantityReserved: 1
        }
      ]
    }
  });
  assert.equal(reserveRes.res.status, 201, JSON.stringify(reserveRes.payload));
  assert.equal(reserveRes.payload?.data?.[0]?.warehouseId, primary.warehouse.id);
});
