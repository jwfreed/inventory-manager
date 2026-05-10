import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ensureTestServer, getBaseUrl } from '../api/helpers/testServer.mjs';
import { getDbPool } from '../helpers/dbPool.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-siamaya-seed';

const {
  runChocolateSeed,
  DEMO_BOM_CODE,
  DEMO_BOM_COMPONENTS,
  DEMO_CUSTOMER,
  DEMO_FINISHED_GOOD,
  DEMO_FLOW_IDS,
  DEMO_FLOW_QUANTITY,
  DEMO_PO,
  DEMO_SKUS,
  DEMO_SO,
  DEMO_SUPPLIER
} = require('../../scripts/chocolate-seed.ts');

const TEST_TENANT_SLUG = 'siamaya';

function seedConfig(mode, tenantSlug, overrides = {}) {
  return {
    mode,
    baseUrl: getBaseUrl(),
    prefix: '',
    adminEmail: `siamaya-seed-${tenantSlug}@example.test`,
    adminPassword: 'admin@local',
    tenantSlug,
    tenantName: 'SIAMAYA',
    logLevel: 'error',
    timeoutMs: 60000,
    reset: true,
    allowLocalAuthRepair: true,
    ...overrides
  };
}

async function tenantIdForSlug(pool, slug) {
  const result = await pool.query('SELECT id FROM tenants WHERE slug = $1', [slug]);
  const tenantId = result.rows[0]?.id;
  assert.ok(tenantId, `tenant missing for ${slug}`);
  return tenantId;
}

async function readManualSeedState(pool, tenantId) {
  const [items, bom, po, so, shipped, locations] = await Promise.all([
    pool.query(
      `SELECT sku, type, default_uom, canonical_uom, stocking_uom, is_purchasable, is_manufactured
         FROM items
        WHERE tenant_id = $1
        ORDER BY sku`,
      [tenantId]
    ),
    pool.query(
      `SELECT b.bom_code,
              bv.status,
              bv.yield_quantity::numeric AS yield_quantity,
              bv.yield_uom,
              i.sku,
              bvl.component_quantity::numeric AS component_quantity,
              bvl.component_uom
         FROM boms b
         JOIN bom_versions bv
           ON bv.bom_id = b.id
          AND bv.tenant_id = b.tenant_id
         JOIN bom_version_lines bvl
           ON bvl.bom_version_id = bv.id
          AND bvl.tenant_id = bv.tenant_id
         JOIN items i
           ON i.id = bvl.component_item_id
          AND i.tenant_id = bvl.tenant_id
        WHERE b.tenant_id = $1
          AND b.bom_code = $2
          AND bv.status = 'active'
        ORDER BY bvl.line_number`,
      [tenantId, DEMO_BOM_CODE]
    ),
    pool.query(
      `SELECT i.sku, pol.quantity_ordered::numeric AS quantity_ordered, pol.uom
         FROM purchase_orders po
         JOIN vendors v
           ON v.id = po.vendor_id
          AND v.tenant_id = po.tenant_id
         JOIN purchase_order_lines pol
           ON pol.purchase_order_id = po.id
          AND pol.tenant_id = po.tenant_id
         JOIN items i
           ON i.id = pol.item_id
          AND i.tenant_id = pol.tenant_id
        WHERE po.tenant_id = $1
          AND po.po_number = $2
          AND v.code = $3
        ORDER BY pol.line_number`,
      [tenantId, DEMO_PO.number, DEMO_SUPPLIER.code]
    ),
    pool.query(
      `SELECT c.code,
              i.sku,
              sol.quantity_ordered::numeric AS quantity_ordered,
              sol.uom
         FROM sales_orders so
         JOIN customers c
           ON c.id = so.customer_id
          AND c.tenant_id = so.tenant_id
         JOIN sales_order_lines sol
           ON sol.sales_order_id = so.id
          AND sol.tenant_id = so.tenant_id
         JOIN items i
           ON i.id = sol.item_id
          AND i.tenant_id = sol.tenant_id
        WHERE so.tenant_id = $1
          AND so.so_number = $2`,
      [tenantId, DEMO_SO.number]
    ),
    pool.query(
      `SELECT COALESCE(SUM(ssl.quantity_shipped), 0)::numeric AS quantity_shipped
         FROM sales_order_shipments s
         JOIN sales_order_shipment_lines ssl
           ON ssl.sales_order_shipment_id = s.id
          AND ssl.tenant_id = s.tenant_id
        WHERE s.tenant_id = $1
          AND s.external_ref = $2`,
      [tenantId, DEMO_FLOW_IDS.shipmentExternalRef]
    ),
    pool.query(
      `SELECT code, role, is_sellable
         FROM locations
        WHERE tenant_id = $1
          AND code = ANY($2::text[])
        ORDER BY code`,
      [tenantId, ['FACTORY_RM_STORE', 'FACTORY_PACK_STORE', 'FACTORY_FG_STAGE']]
    )
  ]);
  return { items: items.rows, bom: bom.rows, po: po.rows, so: so.rows, shipped: shipped.rows[0], locations: locations.rows };
}

function expectedRequirementBySku() {
  return new Map(
    DEMO_BOM_COMPONENTS.map((component) => [
      component.sku,
      { quantity: component.quantityPer * DEMO_FLOW_QUANTITY, uom: component.uom, per: component.quantityPer }
    ])
  );
}

async function apiRequest(method, path, { token, body, idempotencyKey, query } = {}) {
  const url = new URL(getBaseUrl() + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await res.json().catch(() => null)
    : await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`API ${method} ${path} failed status=${res.status} body=${JSON.stringify(payload)}`);
  }
  return payload;
}

async function loginForSeed(config) {
  return apiRequest('POST', '/auth/login', {
    body: {
      email: config.adminEmail,
      password: config.adminPassword,
      tenantSlug: config.tenantSlug
    }
  });
}

async function findLocation(token, code) {
  const result = await apiRequest('GET', '/locations', {
    token,
    query: { search: code, limit: 100, offset: 0 }
  });
  const location = (result.data ?? result).find((row) => row.code === code);
  assert.ok(location, `location missing: ${code}`);
  return location;
}

async function findPurchaseOrder(token) {
  const list = await apiRequest('GET', '/purchase-orders', {
    token,
    query: { search: DEMO_PO.number, limit: 20, offset: 0 }
  });
  const summary = (list.data ?? []).find((row) => row.poNumber === DEMO_PO.number);
  assert.ok(summary, `PO missing: ${DEMO_PO.number}`);
  return apiRequest('GET', `/purchase-orders/${summary.id}`, { token });
}

async function findSalesOrder(token) {
  const list = await apiRequest('GET', '/sales-orders', {
    token,
    query: { limit: 100, offset: 0 }
  });
  const summary = (list.data ?? []).find((row) => (row.soNumber ?? row.so_number) === DEMO_SO.number);
  assert.ok(summary, `SO missing: ${DEMO_SO.number}`);
  return apiRequest('GET', `/sales-orders/${summary.id}`, { token });
}

async function readBomForSeed(pool, tenantId) {
  const result = await pool.query(
    `SELECT b.id AS bom_id, bv.id AS bom_version_id
       FROM boms b
       JOIN bom_versions bv
         ON bv.bom_id = b.id
        AND bv.tenant_id = b.tenant_id
      WHERE b.tenant_id = $1
        AND b.bom_code = $2
        AND bv.status = 'active'
      LIMIT 1`,
    [tenantId, DEMO_BOM_CODE]
  );
  assert.ok(result.rows[0], `active BOM missing: ${DEMO_BOM_CODE}`);
  return result.rows[0];
}

async function readDemoItemsBySku(pool, tenantId) {
  const result = await pool.query(
    `SELECT id, sku
       FROM items
      WHERE tenant_id = $1
        AND sku = ANY($2::text[])`,
    [tenantId, DEMO_SKUS]
  );
  return new Map(result.rows.map((row) => [row.sku, row]));
}

async function readOperationalValidation(pool, tenantId) {
  return (await pool.query(
    `WITH finished AS (
       SELECT id FROM items WHERE tenant_id = $1 AND sku = $2
     ),
     demo_po AS (
       SELECT id FROM purchase_orders WHERE tenant_id = $1 AND po_number = $3
     ),
     demo_so AS (
       SELECT id FROM sales_orders WHERE tenant_id = $1 AND so_number = $4
     ),
     demo_shipment AS (
       SELECT id, inventory_movement_id FROM sales_order_shipments WHERE tenant_id = $1 AND external_ref = $5
     )
     SELECT
       (SELECT COUNT(*)::int FROM purchase_orders WHERE tenant_id = $1 AND po_number = $3) AS po_count,
       (SELECT COUNT(*)::int
          FROM purchase_order_receipts por
          JOIN demo_po po ON po.id = por.purchase_order_id
         WHERE por.tenant_id = $1) AS receipt_count,
       (SELECT COUNT(*)::int FROM work_orders WHERE tenant_id = $1 AND description = $6) AS work_order_count,
       (SELECT COUNT(*)::int FROM sales_orders WHERE tenant_id = $1 AND so_number = $4) AS so_count,
       (SELECT COUNT(*)::int FROM sales_order_shipments WHERE tenant_id = $1 AND external_ref = $5) AS shipment_count,
       (SELECT COUNT(*)::int
          FROM inventory_reservations r
          JOIN sales_order_lines sol ON sol.id = r.demand_id AND sol.tenant_id = r.tenant_id
          JOIN demo_so so ON so.id = sol.sales_order_id
         WHERE r.tenant_id = $1) AS reservation_count,
       (SELECT COALESCE(SUM(ssl.quantity_shipped), 0)::numeric
          FROM sales_order_shipment_lines ssl
          JOIN demo_shipment s ON s.id = ssl.sales_order_shipment_id
          JOIN sales_order_lines sol ON sol.id = ssl.sales_order_line_id AND sol.tenant_id = ssl.tenant_id
          JOIN finished f ON f.id = sol.item_id
         WHERE ssl.tenant_id = $1) AS shipped_qty,
       (SELECT COUNT(*)::int FROM inventory_balance WHERE tenant_id = $1 AND on_hand < -0.000001) AS negative_balance_count,
       (SELECT COUNT(*)::int
          FROM inventory_backorders
         WHERE tenant_id = $1
           AND status NOT IN ('fulfilled', 'cancelled', 'canceled')) AS open_backorder_count,
       (SELECT COUNT(*)::int
          FROM inventory_reservations
         WHERE tenant_id = $1
           AND demand_id IS NULL) AS orphan_reservation_count,
       (SELECT COUNT(*)::int
          FROM inventory_movements
         WHERE tenant_id = $1
           AND status = 'posted') AS posted_movement_count,
       (SELECT COUNT(*)::int
          FROM inventory_movement_lines iml
          JOIN inventory_movements im ON im.id = iml.movement_id AND im.tenant_id = iml.tenant_id
         WHERE iml.tenant_id = $1
           AND im.source_type = 'work_order_batch_post_issue') AS consumed_line_count,
       (SELECT COUNT(*)::int
          FROM inventory_movement_lines iml
          JOIN inventory_movements im ON im.id = iml.movement_id AND im.tenant_id = iml.tenant_id
          JOIN finished f ON f.id = iml.item_id
         WHERE iml.tenant_id = $1
          AND im.source_type = 'work_order_batch_post_completion'
           AND iml.quantity_delta = $7
           AND iml.uom = 'each') AS finished_receipt_line_count,
       (SELECT COUNT(*)::int FROM qc_inventory_links WHERE tenant_id = $1) AS qc_movement_link_count,
      (SELECT COUNT(DISTINCT im.id)::int
         FROM inventory_movements im
         JOIN inventory_movement_lines iml
           ON iml.movement_id = im.id
          AND iml.tenant_id = im.tenant_id
        WHERE im.tenant_id = $1
          AND im.source_type = 'inventory_transfer'
          AND iml.reason_code = 'demo_putaway_to_production_store_in') AS storage_transfer_count`,
    [
      tenantId,
      DEMO_FINISHED_GOOD.sku,
      DEMO_PO.number,
      DEMO_SO.number,
      DEMO_FLOW_IDS.shipmentExternalRef,
      DEMO_FLOW_IDS.workOrderDescription,
      DEMO_FLOW_QUANTITY
    ]
  )).rows[0];
}

async function executeManualDemoFlow({ token, pool, tenantId }) {
  const po = await findPurchaseOrder(token);
  const itemBySku = await readDemoItemsBySku(pool, tenantId);
  const unitCostByItemId = new Map(
    DEMO_BOM_COMPONENTS.map((component) => {
      const item = itemBySku.get(component.sku);
      assert.ok(item, `component item missing: ${component.sku}`);
      return [item.id, component.unitCost];
    })
  );
  const receipt = await apiRequest('POST', '/purchase-order-receipts', {
    token,
    idempotencyKey: 'test:siamaya:manual:e2e:receipt:v1',
    body: {
      purchaseOrderId: po.id,
      receivedAt: '2026-01-16T09:00:00.000Z',
      externalRef: 'TEST-RCPT-MILK-CHOC-1000-INGREDIENTS',
      notes: 'Manual demo e2e test receipt.',
      idempotencyKey: 'test:siamaya:manual:e2e:receipt:v1',
      lines: po.lines.map((line) => ({
        purchaseOrderLineId: line.id,
        uom: line.uom,
        quantityReceived: Number(line.quantityOrdered),
        unitCost: unitCostByItemId.get(line.itemId) ?? 0
      }))
    }
  });

  for (const [index, line] of receipt.lines.entries()) {
    await apiRequest('POST', '/qc-events', {
      token,
      idempotencyKey: `test:siamaya:manual:e2e:qc:${index + 1}:v1`,
      body: {
        purchaseOrderReceiptLineId: line.id,
        eventType: 'accept',
        quantity: Number(line.quantityReceived),
        uom: line.uom,
        reasonCode: 'manual_demo_accept',
        notes: 'Manual demo e2e QC accept.',
        actorType: 'system',
        actorId: 'manual-demo-test'
      }
    });
  }

  const sellable = await findLocation(token, 'SELLABLE');
  const rawStore = await findLocation(token, 'FACTORY_RM_STORE');
  const fgStage = await findLocation(token, 'FACTORY_FG_STAGE');
  const warehouse = await findLocation(token, 'MAIN');
  for (const component of DEMO_BOM_COMPONENTS) {
    const item = itemBySku.get(component.sku);
    assert.ok(item, `component item missing: ${component.sku}`);
    await apiRequest('POST', '/inventory-transfers', {
      token,
      idempotencyKey: `test:siamaya:manual:e2e:store:${component.key}:v1`,
      body: {
        sourceLocationId: sellable.id,
        destinationLocationId: rawStore.id,
        itemId: item.id,
        quantity: component.quantityPer * DEMO_FLOW_QUANTITY,
        uom: component.uom,
        occurredAt: '2026-01-16T10:30:00.000Z',
        reasonCode: 'demo_putaway_to_production_store',
        notes: 'Manual demo e2e storage transfer to RM_STORE.'
      }
    });
  }

  const finished = itemBySku.get(DEMO_FINISHED_GOOD.sku);
  assert.ok(finished, `finished item missing: ${DEMO_FINISHED_GOOD.sku}`);
  const bom = await readBomForSeed(pool, tenantId);
  const workOrder = await apiRequest('POST', '/work-orders', {
    token,
    body: {
      kind: 'production',
      bomId: bom.bom_id,
      bomVersionId: bom.bom_version_id,
      outputItemId: finished.id,
      outputUom: DEMO_FINISHED_GOOD.defaultUom,
      quantityPlanned: DEMO_FLOW_QUANTITY,
      defaultConsumeLocationId: rawStore.id,
      defaultProduceLocationId: fgStage.id,
      scheduledStartAt: '2026-01-16T11:00:00.000Z',
      scheduledDueAt: '2026-01-17',
      description: DEMO_FLOW_IDS.workOrderDescription
    }
  });
  await apiRequest('POST', `/work-orders/${workOrder.id}/report-production`, {
    token,
    idempotencyKey: 'test:siamaya:manual:e2e:report-production:v1',
    body: {
      outputQty: DEMO_FLOW_QUANTITY,
      outputUom: DEMO_FINISHED_GOOD.defaultUom,
      productionBatchId: 'TEST-SIAMAYA-MILK-CHOC-1000-BATCH',
      outputLotCode: 'TEST-SIAMAYA-MILK-CHOC-1000-LOT',
      occurredAt: '2026-01-16T13:00:00.000Z',
      notes: 'Manual demo e2e production.',
      idempotencyKey: 'test:siamaya:manual:e2e:report-production:v1'
    }
  });

  const so = await findSalesOrder(token);
  await apiRequest('POST', '/reservations', {
    token,
    idempotencyKey: 'test:siamaya:manual:e2e:reservation:v1',
    body: {
      reservations: [{
        demandType: 'sales_order_line',
        demandId: so.lines[0].id,
        itemId: finished.id,
        locationId: fgStage.id,
        warehouseId: warehouse.id,
        uom: DEMO_FINISHED_GOOD.defaultUom,
        quantityReserved: DEMO_FLOW_QUANTITY,
        allowBackorder: false,
        notes: 'Manual demo e2e reservation.'
      }]
    }
  });
  const shipment = await apiRequest('POST', '/shipments', {
    token,
    body: {
      salesOrderId: so.id,
      shippedAt: '2026-01-17T15:00:00.000Z',
      shipFromLocationId: fgStage.id,
      externalRef: DEMO_FLOW_IDS.shipmentExternalRef,
      autoAllocateReservations: true,
      notes: 'Manual demo e2e shipment.',
      lines: [{
        salesOrderLineId: so.lines[0].id,
        uom: DEMO_FINISHED_GOOD.defaultUom,
        quantityShipped: DEMO_FLOW_QUANTITY
      }]
    }
  });
  await apiRequest('POST', `/shipments/${shipment.id}/post`, {
    token,
    idempotencyKey: 'test:siamaya:manual:e2e:shipment-post:v1',
    body: {}
  });
}

test('manual Siamaya chocolate seed creates focused prerequisite state only', { timeout: 240000 }, async () => {
  await ensureTestServer();
  const pool = getDbPool();
  const tenantSlug = TEST_TENANT_SLUG;

  await runChocolateSeed(seedConfig('manual', tenantSlug));
  await runChocolateSeed(seedConfig('manual', tenantSlug));

  const tenantId = await tenantIdForSlug(pool, tenantSlug);
  const state = await readManualSeedState(pool, tenantId);
  assert.deepEqual(state.items.map((row) => row.sku), [...DEMO_SKUS].sort());

  const finished = state.items.find((row) => row.sku === DEMO_FINISHED_GOOD.sku);
  assert.equal(finished.type, 'finished');
  assert.equal(finished.default_uom, 'each');
  assert.equal(finished.canonical_uom, 'each');
  assert.equal(finished.stocking_uom, 'each');
  assert.equal(finished.is_purchasable, false);
  assert.equal(finished.is_manufactured, true);

  const locationsByCode = new Map(state.locations.map((row) => [row.code, row]));
  assert.equal(locationsByCode.get('FACTORY_RM_STORE').role, 'SELLABLE');
  assert.equal(locationsByCode.get('FACTORY_RM_STORE').is_sellable, true);
  assert.equal(locationsByCode.get('FACTORY_PACK_STORE').role, 'PACKAGING');
  assert.equal(locationsByCode.get('FACTORY_PACK_STORE').is_sellable, false);
  assert.equal(locationsByCode.get('FACTORY_FG_STAGE').role, 'FG_SELLABLE');
  assert.equal(locationsByCode.get('FACTORY_FG_STAGE').is_sellable, true);

  assert.equal(state.bom.length, DEMO_BOM_COMPONENTS.length);
  assert.ok(state.bom.every((row) => row.bom_code === DEMO_BOM_CODE));
  assert.ok(state.bom.every((row) => row.status === 'active'));
  assert.ok(state.bom.every((row) => Number(row.yield_quantity) === 1));
  assert.ok(state.bom.every((row) => row.yield_uom === 'each'));

  const expected = expectedRequirementBySku();
  let massPerBar = 0;
  for (const row of state.bom) {
    const spec = expected.get(row.sku);
    assert.ok(spec, `unexpected BOM component ${row.sku}`);
    assert.equal(Number(row.component_quantity), spec.per);
    assert.equal(row.component_uom, spec.uom);
    if (row.component_uom === 'g') massPerBar += Number(row.component_quantity);
  }
  assert.equal(massPerBar, 75);
  assert.equal(Number(state.bom.find((row) => row.sku === 'SIAMAYA-MILK-CHOC-FOIL-WRAPPER').component_quantity), 1);

  assert.equal(state.po.length, DEMO_BOM_COMPONENTS.length);
  for (const row of state.po) {
    const spec = expected.get(row.sku);
    assert.ok(spec, `unexpected PO component ${row.sku}`);
    assert.equal(Number(row.quantity_ordered), spec.quantity);
    assert.equal(row.uom, spec.uom);
  }

  assert.equal(state.so.length, 1);
  assert.equal(state.so[0].code, DEMO_CUSTOMER.code);
  assert.equal(state.so[0].sku, DEMO_FINISHED_GOOD.sku);
  assert.equal(Number(state.so[0].quantity_ordered), DEMO_FLOW_QUANTITY);
  assert.equal(state.so[0].uom, 'each');
  assert.equal(Number(state.shipped.quantity_shipped), 0);
});

test('manual Siamaya chocolate seed supports the canonical operational walkthrough', { timeout: 300000 }, async () => {
  await ensureTestServer();
  const pool = getDbPool();
  const tenantSlug = TEST_TENANT_SLUG;
  const config = seedConfig('manual', tenantSlug);

  await runChocolateSeed(config);
  const session = await loginForSeed(config);
  const tenantId = await tenantIdForSlug(pool, tenantSlug);

  await executeManualDemoFlow({ token: session.accessToken, pool, tenantId });

  const row = await readOperationalValidation(pool, tenantId);
  assert.equal(Number(row.po_count), 1);
  assert.equal(Number(row.receipt_count), 1);
  assert.equal(Number(row.work_order_count), 1);
  assert.equal(Number(row.so_count), 1);
  assert.equal(Number(row.shipment_count), 1);
  assert.equal(Number(row.reservation_count), 1);
  assert.equal(Number(row.shipped_qty), DEMO_FLOW_QUANTITY);
  assert.equal(Number(row.negative_balance_count), 0);
  assert.equal(Number(row.open_backorder_count), 0);
  assert.equal(Number(row.orphan_reservation_count), 0);
  assert.ok(Number(row.posted_movement_count) >= 1 + DEMO_BOM_COMPONENTS.length + DEMO_BOM_COMPONENTS.length + 2);
  assert.equal(Number(row.consumed_line_count), DEMO_BOM_COMPONENTS.length);
  assert.equal(Number(row.finished_receipt_line_count), 1);
  assert.equal(Number(row.qc_movement_link_count), DEMO_BOM_COMPONENTS.length);
  assert.equal(Number(row.storage_transfer_count), DEMO_BOM_COMPONENTS.length);
});

test('manual seed rerun reconciles stale seed-owned item metadata', { timeout: 240000 }, async () => {
  await ensureTestServer();
  const pool = getDbPool();
  const tenantSlug = TEST_TENANT_SLUG;

  await runChocolateSeed(seedConfig('manual', tenantSlug));
  const tenantId = await tenantIdForSlug(pool, tenantSlug);
  await pool.query(
    `UPDATE items
        SET name = 'Stale Demo Bar',
            type = 'raw',
            default_uom = 'each',
            uom_dimension = 'count',
            canonical_uom = 'each',
            stocking_uom = 'each',
            is_purchasable = true,
            is_manufactured = false,
            weight = NULL,
            weight_uom = NULL,
            default_location_id = NULL
      WHERE tenant_id = $1
        AND sku = $2`,
    [tenantId, DEMO_FINISHED_GOOD.sku]
  );

  await runChocolateSeed(seedConfig('manual', tenantSlug, { reset: false }));

  const state = await readManualSeedState(pool, tenantId);
  const finished = state.items.find((row) => row.sku === DEMO_FINISHED_GOOD.sku);
  assert.equal(finished.type, 'finished');
  assert.equal(finished.default_uom, 'each');
  assert.equal(finished.canonical_uom, 'each');
  assert.equal(finished.stocking_uom, 'each');
  assert.equal(finished.is_purchasable, false);
  assert.equal(finished.is_manufactured, true);
});

test('completed Siamaya chocolate seed is idempotent with reset disabled on rerun', { timeout: 300000 }, async () => {
  await ensureTestServer();
  const pool = getDbPool();
  const tenantSlug = TEST_TENANT_SLUG;

  await runChocolateSeed(seedConfig('completed', tenantSlug));

  const tenantId = await tenantIdForSlug(pool, tenantSlug);
  const before = await readOperationalValidation(pool, tenantId);

  await runChocolateSeed(seedConfig('completed', tenantSlug, { reset: false }));

  const after = await readOperationalValidation(pool, tenantId);
  assert.equal(Number(after.po_count), 1);
  assert.equal(Number(after.receipt_count), 1);
  assert.equal(Number(after.work_order_count), 1);
  assert.equal(Number(after.so_count), 1);
  assert.equal(Number(after.shipment_count), 1);
  assert.equal(Number(after.reservation_count), 1);
  assert.equal(Number(after.shipped_qty), DEMO_FLOW_QUANTITY);
  assert.equal(Number(after.negative_balance_count), 0);
  assert.equal(Number(after.open_backorder_count), 0);
  assert.equal(Number(after.orphan_reservation_count), 0);
  assert.equal(Number(after.posted_movement_count), Number(before.posted_movement_count));
  assert.equal(Number(after.consumed_line_count), DEMO_BOM_COMPONENTS.length);
  assert.equal(Number(after.finished_receipt_line_count), 1);
  assert.equal(Number(after.qc_movement_link_count), DEMO_BOM_COMPONENTS.length);
  assert.equal(Number(after.storage_transfer_count), DEMO_BOM_COMPONENTS.length);

  const result = await pool.query(
    `WITH finished AS (
       SELECT id FROM items WHERE tenant_id = $1 AND sku = $2
     ),
     shipment AS (
       SELECT s.id
         FROM sales_order_shipments s
        WHERE s.tenant_id = $1
          AND s.external_ref = $3
     )
     SELECT
       (SELECT COALESCE(SUM(ssl.quantity_shipped), 0)::numeric
          FROM sales_order_shipment_lines ssl
          JOIN shipment s ON s.id = ssl.sales_order_shipment_id
          JOIN sales_order_lines sol ON sol.id = ssl.sales_order_line_id AND sol.tenant_id = ssl.tenant_id
          JOIN finished f ON f.id = sol.item_id
         WHERE ssl.tenant_id = $1) AS shipped_qty,
       (SELECT COUNT(*)::int
          FROM inventory_balance
         WHERE tenant_id = $1
           AND on_hand < -0.000001) AS negative_balance_count,
       (SELECT COUNT(*)::int
          FROM inventory_backorders
         WHERE tenant_id = $1
           AND status NOT IN ('fulfilled', 'cancelled', 'canceled')) AS open_backorder_count,
       (SELECT COUNT(*)::int
          FROM inventory_movement_lines iml
          JOIN inventory_movements im ON im.id = iml.movement_id AND im.tenant_id = iml.tenant_id
         WHERE iml.tenant_id = $1
           AND im.source_type = 'work_order_batch_post_issue') AS consumed_line_count`,
    [tenantId, DEMO_FINISHED_GOOD.sku, DEMO_FLOW_IDS.shipmentExternalRef]
  );
  const row = result.rows[0];
  assert.equal(Number(row.shipped_qty), DEMO_FLOW_QUANTITY);
  assert.equal(Number(row.negative_balance_count), 0);
  assert.equal(Number(row.open_backorder_count), 0);
  assert.equal(Number(row.consumed_line_count), DEMO_BOM_COMPONENTS.length);
});
