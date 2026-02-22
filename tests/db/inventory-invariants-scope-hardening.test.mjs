import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import { expectInvariantLog } from '../helpers/invariantLogs.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { runInventoryInvariantCheck } = require('../../src/jobs/inventoryInvariants.job.ts');

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `inv-scope-${randomUUID().slice(0, 8)}`;

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
    tenantName: 'Invariant Scope Hardening Tenant'
  });
}

async function getSessionForScope(label) {
  return ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: `inv-scope-${label}-${randomUUID().slice(0, 8)}`,
    tenantName: `Invariant Scope ${label}`
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

async function createItem(token, defaultLocationId) {
  const sku = `INV-SCOPE-${randomUUID().slice(0, 8)}`;
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
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

test('inventory invariants detect non-sellable flow refs and sales-order warehouse scope mismatches', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const db = session.pool;
  const tenantId = session.tenant.id;
  const warehouseA = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const warehouseB = await createWarehouseWithSellable(token, `WH-${randomUUID().slice(0, 6)}`);
  const itemId = await createItem(token, warehouseA.defaults.SELLABLE.id);

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
      warehouseId: warehouseA.warehouse.id,
      shipFromLocationId: warehouseA.defaults.SELLABLE.id,
      lines: [{ itemId, uom: 'each', quantityOrdered: 1 }]
    }
  });
  assert.equal(soRes.res.status, 201, JSON.stringify(soRes.payload));
  const soLineId = soRes.payload.lines[0].id;

  const reservationRes = await apiRequest('POST', '/reservations', {
    token,
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: soLineId,
          itemId,
          warehouseId: warehouseA.warehouse.id,
          locationId: warehouseA.defaults.SELLABLE.id,
          uom: 'each',
          quantityReserved: 1
        }
      ]
    }
  });
  assert.equal(reservationRes.res.status, 201, JSON.stringify(reservationRes.payload));

  const shipmentRes = await apiRequest('POST', '/shipments', {
    token,
    body: {
      salesOrderId: soRes.payload.id,
      shippedAt: new Date().toISOString(),
      shipFromLocationId: warehouseA.defaults.SELLABLE.id,
      lines: [{ salesOrderLineId: soLineId, uom: 'each', quantityShipped: 1 }]
    }
  });
  assert.equal(shipmentRes.res.status, 201, JSON.stringify(shipmentRes.payload));

  await db.query(
    `UPDATE locations
        SET role = 'QA',
            is_sellable = false,
            updated_at = now()
      WHERE id = $1
        AND tenant_id = $2`,
    [warehouseA.defaults.SELLABLE.id, tenantId]
  );
  await db.query(
    `INSERT INTO sales_order_shipments (
        id,
        tenant_id,
        sales_order_id,
        shipped_at,
        ship_from_location_id,
        inventory_movement_id,
        external_ref,
        notes,
        created_at
      ) VALUES (
        $1,
        $2,
        $3,
        now(),
        $4,
        NULL,
        NULL,
        'scope mismatch fixture',
        now()
      )`,
    [randomUUID(), tenantId, soRes.payload.id, warehouseB.sellable.id]
  );

  expectInvariantLog(/non-sellable reservation\/fulfillment flow reference/);
  expectInvariantLog(/sales-order warehouse scope mismatch/);
  const results = await runInventoryInvariantCheck({ tenantIds: [tenantId] });
  const summary = results.find((row) => row.tenantId === tenantId);
  assert.ok(summary);
  assert.ok((summary.nonSellableFlowScopeInvalidCount ?? 0) > 0);
  assert.ok((summary.salesOrderWarehouseScopeMismatchCount ?? 0) > 0);

  const previousStrict = process.env.INVARIANTS_STRICT;
  process.env.INVARIANTS_STRICT = 'true';
  try {
    await assert.rejects(
      runInventoryInvariantCheck({ tenantIds: [tenantId] }),
      (error) =>
        error?.code === 'INVENTORY_INVARIANTS_STRICT_FAILED'
        && Array.isArray(error?.details?.violations)
        && error.details.violations.some((entry) => entry.tenantId === tenantId)
    );
  } finally {
    if (previousStrict === undefined) {
      delete process.env.INVARIANTS_STRICT;
    } else {
      process.env.INVARIANTS_STRICT = previousStrict;
    }
  }
});

test('inventory invariants job honors INVARIANTS_TENANT_ID scoping when tenantIds option is omitted', async () => {
  const sessionA = await getSessionForScope('env-a');
  const sessionB = await getSessionForScope('env-b');
  const tenantA = sessionA.tenant?.id;
  const tenantB = sessionB.tenant?.id;
  assert.ok(tenantA, 'tenantA is required');
  assert.ok(tenantB, 'tenantB is required');
  assert.notEqual(tenantA, tenantB);

  const previousTenantIdScope = process.env.INVARIANTS_TENANT_ID;
  const previousTenantIdsScope = process.env.INVARIANTS_TENANT_IDS;
  process.env.INVARIANTS_TENANT_ID = tenantA;
  delete process.env.INVARIANTS_TENANT_IDS;

  try {
    const scopedResults = await runInventoryInvariantCheck();
    assert.ok(scopedResults.length > 0, 'expected at least one scoped tenant result');
    assert.ok(
      scopedResults.every((row) => row.tenantId === tenantA),
      `expected all rows scoped to ${tenantA}, got ${JSON.stringify(scopedResults.map((row) => row.tenantId))}`
    );
    assert.ok(
      !scopedResults.some((row) => row.tenantId === tenantB),
      'unexpected result for out-of-scope tenant'
    );
  } finally {
    if (previousTenantIdScope === undefined) {
      delete process.env.INVARIANTS_TENANT_ID;
    } else {
      process.env.INVARIANTS_TENANT_ID = previousTenantIdScope;
    }
    if (previousTenantIdsScope === undefined) {
      delete process.env.INVARIANTS_TENANT_IDS;
    } else {
      process.env.INVARIANTS_TENANT_IDS = previousTenantIdsScope;
    }
  }
});
