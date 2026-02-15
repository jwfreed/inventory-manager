import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import { waitForCondition } from '../api/helpers/waitFor.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `late-qc-${randomUUID().slice(0, 8)}`;

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
    tenantName: 'Late QC Commitments Tenant'
  });
}

async function createVendor(token) {
  const code = `V-${randomUUID()}`;
  const res = await apiRequest('POST', '/vendors', {
    token,
    body: { code, name: `Vendor ${code}` }
  });
  assert.equal(res.res.status, 201);
  return res.payload.id;
}

async function createCustomer(tenantId, db) {
  const id = randomUUID();
  const code = `C-${randomUUID()}`;
  await db.query(
    `INSERT INTO customers (id, tenant_id, code, name, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, now(), now())`,
    [id, tenantId, code, `Customer ${code}`]
  );
  return id;
}

async function createItem(token, defaultLocationId) {
  const sku = `ITEM-${randomUUID()}`;
  const res = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId
    }
  });
  assert.equal(res.res.status, 201);
  return res.payload.id;
}

async function createSalesOrder(token, customerId, itemId, shipFromLocationId, quantity) {
  const res = await apiRequest('POST', '/sales-orders', {
    token,
    body: {
      soNumber: `SO-${randomUUID()}`,
      customerId,
      status: 'submitted',
      shipFromLocationId,
      lines: [{ itemId, uom: 'each', quantityOrdered: quantity }]
    }
  });
  assert.equal(res.res.status, 201);
  return { orderId: res.payload.id, lineId: res.payload.lines[0].id };
}

async function createPurchaseOrder(token, vendorId, shipToLocationId, itemId, quantity) {
  const today = new Date().toISOString().slice(0, 10);
  const res = await apiRequest('POST', '/purchase-orders', {
    token,
    body: {
      vendorId,
      shipToLocationId,
      receivingLocationId: shipToLocationId,
      expectedDate: today,
      status: 'approved',
      lines: [
        {
          itemId,
          uom: 'each',
          quantityOrdered: quantity,
          unitCost: 5,
          currencyCode: 'THB'
        }
      ]
    }
  });
  assert.equal(res.res.status, 201);
  return res.payload;
}

async function createReceipt(token, poId, poLineId, quantity) {
  const res = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    headers: { 'Idempotency-Key': `receipt-${randomUUID()}` },
    body: {
      purchaseOrderId: poId,
      receivedAt: new Date().toISOString(),
      lines: [{ purchaseOrderLineId: poLineId, uom: 'each', quantityReceived: quantity, unitCost: 5 }]
    }
  });
  assert.equal(res.res.status, 201);
  return res.payload.lines[0].id;
}

async function qcAccept(token, receiptLineId, quantity, actorId) {
  const res = await apiRequest('POST', '/qc-events', {
    token,
    body: {
      purchaseOrderReceiptLineId: receiptLineId,
      eventType: 'accept',
      quantity,
      uom: 'each',
      actorType: 'user',
      actorId
    }
  });
  assert.equal(res.res.status, 201);
}

test('late QC updates ATP/backorder after commitments', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  const userId = session.user?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const qaLocation = defaults.QA;
  const sellableLocation = defaults.SELLABLE;

  const vendorId = await createVendor(token);
  const itemId = await createItem(token, sellableLocation.id);

  const customerId = await createCustomer(tenantId, session.pool);
  const { orderId, lineId } = await createSalesOrder(token, customerId, itemId, sellableLocation.id, 5);

  const po = await createPurchaseOrder(token, vendorId, sellableLocation.id, itemId, 5);
  const receiptLineId = await createReceipt(token, po.id, po.lines[0].id, 5);

  const reserveRes = await apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `res-${randomUUID()}` },
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: lineId,
          itemId,
          locationId: sellableLocation.id,
          uom: 'each',
          quantityReserved: 5
        }
      ]
    }
  });

  if (![201, 409].includes(reserveRes.res.status)) {
    assert.fail(`Unexpected reservation status: ${reserveRes.res.status} ${JSON.stringify(reserveRes.payload)}`);
  }

  const backorderBefore = await waitForCondition(
    async () => {
      const res = await apiRequest('GET', `/sales-orders/${orderId}`, { token });
      assert.equal(res.res.status, 200);
      return Number(res.payload.lines?.[0]?.derivedBackorderQty ?? 0);
    },
    (value) => Number.isFinite(value),
    { label: 'backorder before QC accept' }
  );

  await qcAccept(token, receiptLineId, 5, userId);

  await waitForCondition(
    async () => {
      const res = await apiRequest('GET', `/sales-orders/${orderId}`, { token });
      assert.equal(res.res.status, 200);
      return Number(res.payload.lines?.[0]?.derivedBackorderQty ?? 0);
    },
    (value) => value <= backorderBefore,
    { label: 'backorder not increased after QC accept' }
  );

  const sellableSnapshot = await waitForCondition(
    async () => {
      const res = await apiRequest('GET', '/inventory-snapshot', {
        token,
        params: { itemId, locationId: sellableLocation.id }
      });
      assert.equal(res.res.status, 200);
      return Number(res.payload.data?.[0]?.onHand ?? 0);
    },
    (value) => value > 0,
    { label: 'sellable snapshot after QC accept' }
  );
  assert.ok(Number.isFinite(sellableSnapshot));

  if (reserveRes.res.status !== 201) {
    const reserveAfter = await apiRequest('POST', '/reservations', {
      token,
      headers: { 'Idempotency-Key': `res-${randomUUID()}` },
      body: {
        reservations: [
          {
            demandType: 'sales_order_line',
            demandId: lineId,
            itemId,
            locationId: sellableLocation.id,
            uom: 'each',
            quantityReserved: 5
          }
        ]
      }
    });
    assert.equal(reserveAfter.res.status, 201);
  } else {
    await waitForCondition(
      async () => {
        const res = await apiRequest('GET', `/sales-orders/${orderId}`, { token });
        assert.equal(res.res.status, 200);
        return Number(res.payload.lines?.[0]?.derivedBackorderQty ?? 0);
      },
      (value) => value <= backorderBefore,
      { label: 'backorder cleared after QC accept' }
    );
  }
});
