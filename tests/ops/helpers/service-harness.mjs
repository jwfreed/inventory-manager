import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { getDbPool } from '../../helpers/dbPool.mjs';
import { seedWarehouseTopologyForTenant } from '../../../scripts/seed_warehouse_topology.mjs';

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { createItem: createItemService, createLocation } = require('../../../src/services/masterData.service.ts');
const { ensureWarehouseDefaultsForWarehouse } = require('../../../src/services/warehouseDefaults.service.ts');
const { createVendor: createVendorService } = require('../../../src/services/vendors.service.ts');
const { createPurchaseOrder } = require('../../../src/services/purchaseOrders.service.ts');
const { createPurchaseOrderReceipt } = require('../../../src/services/receipts.service.ts');
const { createLicensePlate, moveLicensePlate } = require('../../../src/services/licensePlates.service.ts');
const { createBom, activateBomVersion } = require('../../../src/services/boms.service.ts');
const { createWorkOrder } = require('../../../src/services/workOrders.service.ts');
const {
  createWorkOrderIssue,
  postWorkOrderIssue,
  createWorkOrderCompletion,
  postWorkOrderCompletion,
  recordWorkOrderBatch,
  reportWorkOrderProduction,
  voidWorkOrderProductionReport
} = require('../../../src/services/workOrderExecution.service.ts');
const { createQcEvent, postQcWarehouseDisposition } = require('../../../src/services/qc.service.ts');
const { postInventoryTransfer } = require('../../../src/services/transfers.service.ts');
const { createInventoryCount, postInventoryCount } = require('../../../src/services/counts.service.ts');

function buildTenantSlug(prefix = 'ops') {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function ensureTenant(pool, { tenantSlug, tenantName }) {
  const existing = await pool.query('SELECT id FROM tenants WHERE slug = $1 LIMIT 1', [tenantSlug]);
  if ((existing.rowCount ?? 0) > 0) {
    return existing.rows[0].id;
  }
  const tenantId = randomUUID();
  await pool.query(
    `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
     VALUES ($1, $2, $3, NULL, now())`,
    [tenantId, tenantName, tenantSlug]
  );
  return tenantId;
}

async function ensureTopology(pool, tenantId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await seedWarehouseTopologyForTenant(client, tenantId, { fix: true });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function loadWarehouseTopology(pool, tenantId, warehouseId = null) {
  const warehouseResult = warehouseId
    ? await pool.query(
        `SELECT id, code, name, type, role, warehouse_id, parent_location_id
           FROM locations
          WHERE tenant_id = $1
            AND id = $2
          LIMIT 1`,
        [tenantId, warehouseId]
      )
    : await pool.query(
        `SELECT id, code, name, type, role, warehouse_id, parent_location_id
           FROM locations
          WHERE tenant_id = $1
            AND type = 'warehouse'
            AND parent_location_id IS NULL
          ORDER BY created_at ASC, id ASC
          LIMIT 1`,
        [tenantId]
      );
  const warehouse = warehouseResult.rows[0];
  if (!warehouse?.id) {
    throw new Error('HARNESS_WAREHOUSE_NOT_FOUND');
  }

  const locationsResult = await pool.query(
    `SELECT id,
            code,
            name,
            type,
            role,
            warehouse_id AS "warehouseId",
            parent_location_id AS "parentLocationId",
            is_sellable AS "isSellable",
            created_at AS "createdAt"
       FROM locations
      WHERE tenant_id = $1
        AND warehouse_id = $2
      ORDER BY created_at ASC, id ASC`,
    [tenantId, warehouse.id]
  );
  const locations = locationsResult.rows;
  const defaults = {};
  for (const role of ['SELLABLE', 'QA', 'HOLD', 'REJECT', 'SCRAP']) {
    defaults[role] = locations.find((location) => location.role === role) ?? null;
  }

  return {
    warehouse: {
      id: warehouse.id,
      code: warehouse.code,
      name: warehouse.name,
      type: warehouse.type,
      role: warehouse.role,
      warehouseId: warehouse.warehouse_id,
      parentLocationId: warehouse.parent_location_id
    },
    defaults,
    locations
  };
}

async function withWarehouseDefaultsRepairEnabled(action) {
  const previous = process.env.WAREHOUSE_DEFAULTS_REPAIR;
  process.env.WAREHOUSE_DEFAULTS_REPAIR = 'true';
  try {
    return await action();
  } finally {
    if (previous === undefined) {
      delete process.env.WAREHOUSE_DEFAULTS_REPAIR;
    } else {
      process.env.WAREHOUSE_DEFAULTS_REPAIR = previous;
    }
  }
}

function createStartBarrier(participants) {
  let waiting = 0;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  return {
    async wait() {
      waiting += 1;
      if (waiting >= participants) {
        release();
      }
      await ready;
    }
  };
}

export async function createServiceHarness(options = {}) {
  const pool = getDbPool();
  const tenantSlug = options.tenantSlug ?? buildTenantSlug(options.tenantPrefix ?? 'ops');
  const tenantName = options.tenantName ?? `Ops Harness ${tenantSlug}`;
  const tenantId = await ensureTenant(pool, { tenantSlug, tenantName });
  await ensureTopology(pool, tenantId);
  const topology = await loadWarehouseTopology(pool, tenantId);

  async function refreshTopology(warehouseId = topology.warehouse.id) {
    return loadWarehouseTopology(pool, tenantId, warehouseId);
  }

  async function createWarehouseWithSellable(codePrefix) {
    const warehouse = await withWarehouseDefaultsRepairEnabled(() =>
      createLocation(tenantId, {
        code: `${codePrefix}-WH`,
        name: `${codePrefix} Warehouse`,
        type: 'warehouse',
        active: true
      })
    );
    await ensureWarehouseDefaultsForWarehouse(tenantId, warehouse.id, { repair: true });
    const warehouseTopology = await refreshTopology(warehouse.id);
    const sellable = warehouseTopology.defaults.SELLABLE;
    if (!sellable?.id) {
      throw new Error('HARNESS_WAREHOUSE_SELLABLE_DEFAULT_MISSING');
    }
    return {
      warehouse,
      sellable,
      topology: warehouseTopology
    };
  }

  async function createItem(params) {
    return createItemService(tenantId, {
      sku: `${params.skuPrefix}-${randomUUID().slice(0, 8)}`,
      name: params.name ?? `Item ${params.skuPrefix}`,
      type: params.type ?? 'raw',
      defaultUom: params.defaultUom ?? 'each',
      uomDimension: params.uomDimension ?? 'count',
      canonicalUom: params.canonicalUom ?? 'each',
      stockingUom: params.stockingUom ?? 'each',
      defaultLocationId: params.defaultLocationId,
      active: params.active ?? true,
      requiresLot: params.requiresLot ?? false,
      requiresSerial: params.requiresSerial ?? false,
      requiresQc: params.requiresQc ?? false
    });
  }

  async function createVendor(codePrefix = 'V') {
    const code = `${codePrefix}-${randomUUID().slice(0, 8)}`;
    return createVendorService(tenantId, {
      code,
      name: `Vendor ${code}`
    });
  }

  async function seedStockViaCount({
    warehouseId = topology.warehouse.id,
    itemId,
    locationId,
    quantity,
    unitCost,
    uom = 'each',
    countedAt = '2026-01-01T00:00:00.000Z'
  }) {
    const count = await createInventoryCount(
      tenantId,
      {
        countedAt,
        warehouseId,
        locationId,
        lines: [
          {
            itemId,
            locationId,
            uom,
            countedQuantity: quantity,
            unitCostForPositiveAdjustment: unitCost,
            reasonCode: 'seed'
          }
        ]
      },
      {
        idempotencyKey: `seed-count:${tenantId}:${itemId}:${locationId}:${quantity}:${unitCost}:${uom}`
      }
    );
    return postInventoryCount(
      tenantId,
      count.id,
      `seed-count-post:${tenantId}:${count.id}`,
      {
        expectedWarehouseId: warehouseId,
        actor: { type: 'system', id: null }
      }
    );
  }

  async function createReceipt(params) {
    const purchaseOrder = await createPurchaseOrder(
      tenantId,
      {
        vendorId: params.vendorId,
        shipToLocationId: params.locationId,
        receivingLocationId: params.locationId,
        expectedDate: new Date(params.receivedAt ?? '2026-01-10T00:00:00.000Z').toISOString().slice(0, 10),
        status: 'approved',
        lines: [
          {
            itemId: params.itemId,
            uom: params.uom ?? 'each',
            quantityOrdered: params.quantity,
            unitCost: params.unitCost,
            currencyCode: 'THB'
          }
        ]
      },
      { type: 'system', id: null }
    );
    const receipt = await createPurchaseOrderReceipt(
      tenantId,
      {
        purchaseOrderId: purchaseOrder.id,
        receivedAt: params.receivedAt ?? '2026-01-11T00:00:00.000Z',
        lines: [
          {
            purchaseOrderLineId: purchaseOrder.lines[0].id,
            uom: params.uom ?? 'each',
            quantityReceived: params.quantity,
            unitCost: params.unitCost
          }
        ],
        idempotencyKey: params.idempotencyKey ?? `receipt:${tenantId}:${randomUUID()}`
      },
      { type: 'system', id: null }
    );
    return receipt.receipt;
  }

  async function qcAcceptReceiptLine({ receiptLineId, quantity, uom = 'each', actorId = null }) {
    return createQcEvent(
      tenantId,
      {
        purchaseOrderReceiptLineId: receiptLineId,
        eventType: 'accept',
        quantity,
        uom,
        actorType: actorId ? 'user' : 'system',
        actorId
      },
      {
        idempotencyKey: `qc-accept:${tenantId}:${receiptLineId}:${quantity}:${uom}`
      }
    );
  }

  async function createBomAndActivate({ outputItemId, components, suffix }) {
    const bom = await createBom(tenantId, {
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
          uom: component.uom ?? 'each',
          quantityPer: component.quantityPer
        }))
      }
    });
    await activateBomVersion(
      tenantId,
      bom.versions[0].id,
      {},
      new Date('2026-01-01T00:00:00.000Z'),
      null
    );
    return bom;
  }

  function runStrictInvariants() {
    return execFileAsync(
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

  async function runConcurrently(taskFactories) {
    const barrier = createStartBarrier(taskFactories.length);
    return Promise.allSettled(
      taskFactories.map((taskFactory) => taskFactory({ waitForStart: () => barrier.wait() }))
    );
  }

  return {
    pool,
    tenantId,
    tenantSlug,
    topology,
    refreshTopology,
    createWarehouseWithSellable,
    createItem,
    createVendor,
    seedStockViaCount,
    createReceipt,
    qcAcceptReceiptLine,
    createLicensePlate: (data, actor) => createLicensePlate(tenantId, data, actor),
    moveLicensePlate: (data, actor) => moveLicensePlate(tenantId, data, actor),
    createBomAndActivate,
    createWorkOrder: (data) => createWorkOrder(tenantId, data),
    createWorkOrderIssueDraft: (workOrderId, data, options) =>
      createWorkOrderIssue(tenantId, workOrderId, data, options),
    postWorkOrderIssueDraft: (workOrderId, issueId, context) =>
      postWorkOrderIssue(tenantId, workOrderId, issueId, context),
    createWorkOrderCompletionDraft: (workOrderId, data, options) =>
      createWorkOrderCompletion(tenantId, workOrderId, data, options),
    postWorkOrderCompletionDraft: (workOrderId, completionId) =>
      postWorkOrderCompletion(tenantId, workOrderId, completionId),
    recordBatch: (workOrderId, data, context, options) =>
      recordWorkOrderBatch(tenantId, workOrderId, data, context, options),
    reportProduction: (workOrderId, data, context, options) =>
      reportWorkOrderProduction(tenantId, workOrderId, data, context, options),
    voidProductionReport: (workOrderId, data, actor, options) =>
      voidWorkOrderProductionReport(tenantId, workOrderId, data, actor, options),
    qcWarehouseDisposition: (action, data, actor, options) =>
      postQcWarehouseDisposition(tenantId, action, data, actor, options),
    postTransfer: (data) => postInventoryTransfer({ tenantId, ...data }),
    createStartBarrier,
    runConcurrently,
    countInventoryMovementsBySourceType: async (sourceType) => {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS count
           FROM inventory_movements
          WHERE tenant_id = $1
            AND source_type = $2`,
        [tenantId, sourceType]
      );
      return Number(result.rows[0]?.count ?? 0);
    },
    countIdempotencyRows: async (key) => {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS count
           FROM idempotency_keys
          WHERE tenant_id = $1
            AND key = $2`,
        [tenantId, key]
      );
      return Number(result.rows[0]?.count ?? 0);
    },
    readOnHand: async (itemId, locationId) => {
      const result = await pool.query(
        `SELECT COALESCE(on_hand, 0)::numeric AS on_hand
           FROM inventory_balance
          WHERE tenant_id = $1
            AND item_id = $2
            AND location_id = $3`,
        [tenantId, itemId, locationId]
      );
      return Number(result.rows[0]?.on_hand ?? 0);
    },
    runStrictInvariants
  };
}
