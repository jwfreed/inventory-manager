import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { seedWarehouseTopologyForTenant } from '../../scripts/seed_warehouse_topology.mjs';

const execFileAsync = promisify(execFile);

// Keep load-test pool sizing explicit so worker fanout does not hit connect timeout noise.
if (!process.env.DB_POOL_MAX) {
  process.env.DB_POOL_MAX = '60';
}
if (!process.env.DB_STATEMENT_TIMEOUT_MS) {
  process.env.DB_STATEMENT_TIMEOUT_MS = '15000';
}
if (!process.env.ATP_SERIALIZABLE_RETRIES) {
  process.env.ATP_SERIALIZABLE_RETRIES = '10';
}
if (!process.env.ATP_RESERVATION_CREATE_RETRIES) {
  process.env.ATP_RESERVATION_CREATE_RETRIES = '50';
}

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { pool: sharedDbPool, query } = require('../../src/db.ts');
const { createItem } = require('../../src/services/masterData.service.ts');
const { createInventoryAdjustment } = require('../../src/services/adjustments/core.service.ts');
const { postInventoryAdjustment } = require('../../src/services/adjustments/posting.service.ts');
const {
  createSalesOrder,
  createReservations,
  __setAtpMetricsSinkForTests
} = require('../../src/services/orderToCash.service.ts');
const { postInventoryTransfer } = require('../../src/services/transfers.service.ts');

function parseBoundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

const CONFIG = {
  deterministicSeed: parseBoundedInt(process.env.LOAD_TEST_SEED, 20260223, 1, 2147483647),
  skuCount: parseBoundedInt(process.env.LOAD_TEST_SKU_COUNT, 120, 50, 200),
  workersPerStore: parseBoundedInt(process.env.LOAD_TEST_WORKERS_PER_STORE, 10, 10, 50),
  baselineIterations: parseBoundedInt(process.env.LOAD_TEST_BASELINE_ITERATIONS, 8, 4, 30),
  stressIterations: parseBoundedInt(process.env.LOAD_TEST_STRESS_ITERATIONS, 12, 6, 40),
  transferWorkersPerStore: parseBoundedInt(process.env.LOAD_TEST_TRANSFER_WORKERS_PER_STORE, 2, 2, 20),
  warmupQtyPerSku: parseBoundedInt(process.env.LOAD_TEST_WARMUP_QTY_PER_SKU, 20, 5, 200),
  initialFactoryQtyPerSku: parseBoundedInt(process.env.LOAD_TEST_INITIAL_FACTORY_QTY_PER_SKU, 220, 50, 5000),
  maxAttemptsPerOperationCap: parseBoundedInt(
    process.env.LOAD_TEST_MAX_ATTEMPTS_PER_OPERATION ?? process.env.LOAD_TEST_MAX_RETRY_ATTEMPTS,
    parseBoundedInt(process.env.ATP_RESERVATION_CREATE_RETRIES, 6, 0, 50) + 1,
    1,
    60
  )
};

function createSeededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function seedFromParts(...parts) {
  let seed = 2166136261 ^ CONFIG.deterministicSeed;
  for (const part of parts) {
    const text = String(part);
    for (let index = 0; index < text.length; index += 1) {
      seed ^= text.charCodeAt(index);
      seed = Math.imul(seed, 16777619);
      seed >>>= 0;
    }
  }
  return seed >>> 0;
}

function pickIndex(rng, length) {
  return Math.floor(rng() * length);
}

function pickTwoDistinctSkuIds(rng, skuIds) {
  const firstIndex = pickIndex(rng, skuIds.length);
  let secondIndex = pickIndex(rng, skuIds.length - 1);
  if (secondIndex >= firstIndex) secondIndex += 1;
  return [skuIds[firstIndex], skuIds[secondIndex]];
}

function buildDeterministicSkuPool(allSkuIds, seed, poolSize) {
  const boundedSize = Math.max(2, Math.min(allSkuIds.length, poolSize));
  const startIndex = ((seed % allSkuIds.length) + allSkuIds.length) % allSkuIds.length;
  const pool = [];
  for (let offset = 0; offset < boundedSize; offset += 1) {
    pool.push(allSkuIds[(startIndex + offset) % allSkuIds.length]);
  }
  return pool;
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const bounded = Math.max(0, Math.min(1, ratio));
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * bounded) - 1));
  return sorted[index];
}

function roundMetric(value) {
  return Math.round(toFiniteNumber(value) * 1000) / 1000;
}

function buildHistogram(values, bucketUpperBounds) {
  const bounds = Array.isArray(bucketUpperBounds) && bucketUpperBounds.length > 0
    ? bucketUpperBounds
    : [1, 2, 5, 10, 20, 50];
  const counts = new Map(bounds.map((bound) => [`<=${bound}`, 0]));
  counts.set(`>${bounds[bounds.length - 1]}`, 0);

  for (const value of values) {
    const numericValue = toFiniteNumber(value, 0);
    let bucketed = false;
    for (const bound of bounds) {
      if (numericValue <= bound) {
        counts.set(`<=${bound}`, (counts.get(`<=${bound}`) ?? 0) + 1);
        bucketed = true;
        break;
      }
    }
    if (!bucketed) {
      const overflowKey = `>${bounds[bounds.length - 1]}`;
      counts.set(overflowKey, (counts.get(overflowKey) ?? 0) + 1);
    }
  }

  return Object.fromEntries(counts);
}

function roundMetricInPlace(value) {
  return roundMetric(value);
}

function getInvariantCount(stdout, sectionName) {
  const match = new RegExp(`\\[${sectionName}\\] count=(\\d+)`).exec(stdout);
  assert.ok(match, `Invariant section missing from output: ${sectionName}`);
  return Number(match[1]);
}

function buildPerWarehouseMap(stores, initial = 0) {
  const map = new Map();
  for (const store of stores) {
    map.set(store.warehouseId, initial);
  }
  return map;
}

function mapPerWarehouseByCode(storesByWarehouseId, valuesByWarehouseId) {
  const result = {};
  for (const [warehouseId, value] of valuesByWarehouseId.entries()) {
    const store = storesByWarehouseId.get(warehouseId);
    const key = store ? store.warehouseCode : warehouseId;
    result[key] = value;
  }
  return result;
}

function isTxRetryExhausted(error) {
  return (error?.code ?? error?.cause?.code) === 'TX_RETRY_EXHAUSTED';
}

function makeHotspotKey(warehouseId, itemId) {
  return `${warehouseId}:${itemId}`;
}

async function runWithConcurrency(taskFactories, concurrency) {
  if (taskFactories.length === 0) return [];
  const boundedConcurrency = Math.max(1, Math.floor(concurrency));
  const results = new Array(taskFactories.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= taskFactories.length) return;
      results[current] = await taskFactories[current]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(boundedConcurrency, taskFactories.length) }, () => worker()));
  return results;
}

async function createLoadTenant() {
  const tenantId = randomUUID();
  const tenantSlug = `load-mw-${randomUUID().slice(0, 8)}`;
  await query(
    `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
     VALUES ($1, $2, $3, NULL, now())`,
    [tenantId, 'Phase 4.3 Multi-Warehouse Load Tenant', tenantSlug]
  );
  return { tenantId, tenantSlug };
}

async function provisionCanonicalTopology(tenantId) {
  const client = await sharedDbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await seedWarehouseTopologyForTenant(client, tenantId, { fix: true });
    await seedWarehouseTopologyForTenant(client, tenantId, { fix: false });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function resolveWarehouseScopes(tenantId) {
  const res = await query(
    `SELECT wh.id AS warehouse_id,
            wh.code AS warehouse_code,
            wdl.location_id AS sellable_location_id
       FROM locations wh
       JOIN warehouse_default_location wdl
         ON wdl.tenant_id = wh.tenant_id
        AND wdl.warehouse_id = wh.id
        AND wdl.role = 'SELLABLE'
      WHERE wh.tenant_id = $1
        AND wh.type = 'warehouse'
        AND wh.parent_location_id IS NULL
      ORDER BY wh.code ASC`,
    [tenantId]
  );

  const factory = res.rows.find((row) => row.warehouse_code === 'FACTORY');
  assert.ok(factory, 'FACTORY warehouse root is required');
  const stores = res.rows
    .filter((row) => row.warehouse_code.startsWith('STORE_'))
    .slice(0, 3)
    .map((row, index) => ({
      warehouseId: row.warehouse_id,
      warehouseCode: row.warehouse_code,
      sellableLocationId: row.sellable_location_id,
      index
    }));
  assert.equal(stores.length, 3, `Expected 3 store warehouses, got ${stores.length}`);
  return {
    factory: {
      warehouseId: factory.warehouse_id,
      warehouseCode: factory.warehouse_code,
      sellableLocationId: factory.sellable_location_id
    },
    stores
  };
}

async function createStoreCustomers(tenantId, stores) {
  const customersByWarehouseId = new Map();
  const customerCodeSuffix = randomUUID().slice(0, 8).toUpperCase();
  for (const store of stores) {
    const id = randomUUID();
    await query(
      `INSERT INTO customers (id, tenant_id, code, name, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, now(), now())`,
      [
        id,
        tenantId,
        `LOAD-${store.warehouseCode}-${customerCodeSuffix}`,
        `Load Customer ${store.warehouseCode}`
      ]
    );
    customersByWarehouseId.set(store.warehouseId, id);
  }
  return customersByWarehouseId;
}

async function createSkuCatalog(tenantId, defaultLocationId, skuCount) {
  const skuIds = [];
  const skuPrefix = `LD-${randomUUID().slice(0, 8).toUpperCase()}`;
  for (let index = 0; index < skuCount; index += 1) {
    const sku = `${skuPrefix}-SKU-${String(index + 1).padStart(4, '0')}`;
    const item = await createItem(tenantId, {
      sku,
      name: `Load SKU ${index + 1}`,
      type: 'finished',
      defaultUom: 'each',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId
    });
    skuIds.push(item.id);
  }
  return skuIds;
}

async function seedInitialFactoryStock(tenantId, factorySellableLocationId, skuIds, quantityPerSku) {
  const adjustment = await createInventoryAdjustment(
    tenantId,
    {
      occurredAt: new Date().toISOString(),
      notes: 'Phase 4.3 factory load seed',
      lines: skuIds.map((itemId, index) => ({
        lineNumber: index + 1,
        itemId,
        locationId: factorySellableLocationId,
        uom: 'each',
        quantityDelta: quantityPerSku,
        reasonCode: 'load_seed_factory'
      }))
    },
    { type: 'system', id: null, role: 'system' },
    { idempotencyKey: `phase43-load-seed-${tenantId}` }
  );
  await postInventoryAdjustment(tenantId, adjustment.id, {
    actor: { type: 'system', id: null, role: 'system' }
  });
}

async function warmupStoreInventory({ tenantId, factory, stores, skuIds, quantityPerSku }) {
  const tasks = [];
  for (const store of stores) {
    for (const itemId of skuIds) {
      const idempotencyKey = `phase43-warmup:${store.warehouseId}:${itemId}`;
      tasks.push(async () => {
        const maxAttempts = 4;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            await postInventoryTransfer({
              tenantId,
              sourceLocationId: factory.sellableLocationId,
              destinationLocationId: store.sellableLocationId,
              itemId,
              quantity: quantityPerSku,
              uom: 'each',
              reasonCode: 'phase43_warmup',
              notes: 'Phase 4.3 warmup transfer',
              actorId: null,
              idempotencyKey
            });
            return;
          } catch (error) {
            if (!isTxRetryExhausted(error) || attempt >= maxAttempts) {
              throw error;
            }
          }
        }
      });
    }
  }
  await runWithConcurrency(tasks, 1);
}

function createAtpMetricsCapture() {
  const lockWaitByWarehouse = new Map();
  const lockWaitAll = [];
  const lockWaitByWarehouseItem = new Map();
  let retryAttemptsTotal = 0;
  let exhaustionEventCount = 0;
  let maxAttemptsPerOperationObserved = 1;

  const sink = (event, payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (event === 'atp_lock_wait_ms') {
      const lockWaitMs = toFiniteNumber(payload.atp_lock_wait_ms, 0);
      lockWaitAll.push(lockWaitMs);
      const warehouseIds = Array.isArray(payload.warehouseIds)
        ? payload.warehouseIds.filter((value) => typeof value === 'string')
        : typeof payload.warehouseId === 'string'
          ? [payload.warehouseId]
          : [];
      for (const warehouseId of warehouseIds) {
        if (!lockWaitByWarehouse.has(warehouseId)) {
          lockWaitByWarehouse.set(warehouseId, []);
        }
        lockWaitByWarehouse.get(warehouseId).push(lockWaitMs);
      }

      const itemIds = Array.isArray(payload.itemIds)
        ? payload.itemIds.filter((value) => typeof value === 'string')
        : typeof payload.itemId === 'string'
          ? [payload.itemId]
          : [];
      if (warehouseIds.length > 0 && itemIds.length > 0) {
        const pairCount = warehouseIds.length * itemIds.length;
        const lockWaitShareMs = lockWaitMs / Math.max(1, pairCount);
        for (const warehouseId of warehouseIds) {
          for (const itemId of itemIds) {
            const key = makeHotspotKey(warehouseId, itemId);
            const current = lockWaitByWarehouseItem.get(key) ?? {
              warehouseId,
              itemId,
              totalLockWaitMs: 0,
              count: 0,
              maxLockWaitMs: 0
            };
            current.totalLockWaitMs += lockWaitShareMs;
            current.count += 1;
            current.maxLockWaitMs = Math.max(current.maxLockWaitMs, lockWaitMs);
            lockWaitByWarehouseItem.set(key, current);
          }
        }
      }
      return;
    }
    if (event === 'atp_tx_retry_attempts') {
      retryAttemptsTotal += 1;
      const attempt = toFiniteNumber(payload.attempt, 0);
      if ((attempt + 1) > maxAttemptsPerOperationObserved) {
        maxAttemptsPerOperationObserved = attempt + 1;
      }
      return;
    }
    if (event === 'atp_retry_count') {
      const attempts = toFiniteNumber(payload.attempts, 0);
      if (attempts > maxAttemptsPerOperationObserved) {
        maxAttemptsPerOperationObserved = attempts;
      }
      return;
    }
    if (event === 'atp_concurrency_exhausted_count') {
      exhaustionEventCount += toFiniteNumber(payload.count, 1);
    }
  };

  function buildHotspotSummary(limit = 5) {
    return Array.from(lockWaitByWarehouseItem.values())
      .sort((left, right) => {
        const waitCompare = right.totalLockWaitMs - left.totalLockWaitMs;
        if (waitCompare !== 0) return waitCompare;
        return makeHotspotKey(left.warehouseId, left.itemId).localeCompare(makeHotspotKey(right.warehouseId, right.itemId));
      })
      .slice(0, Math.max(0, limit))
      .map((row) => ({
        warehouseId: row.warehouseId,
        itemId: row.itemId,
        totalLockWaitMs: roundMetricInPlace(row.totalLockWaitMs),
        avgLockWaitMs: roundMetricInPlace(row.totalLockWaitMs / Math.max(1, row.count)),
        maxLockWaitMs: roundMetricInPlace(row.maxLockWaitMs),
        count: row.count
      }));
  }

  const snapshot = () => ({
    lockWaitAll,
    lockWaitByWarehouse,
    retryAttemptsTotal,
    exhaustionEventCount,
    maxAttemptsPerOperationObserved,
    maxRetriesPerOperationObserved: Math.max(0, maxAttemptsPerOperationObserved - 1),
    lockWaitHistogramMs: buildHistogram(lockWaitAll, [1, 2, 5, 10, 20, 50]),
    lockWaitHotspots: buildHotspotSummary(5),
    avgLockWaitMs: average(lockWaitAll),
    p95LockWaitMs: percentile(lockWaitAll, 0.95)
  });

  return { sink, snapshot };
}

async function runSalesWorker({
  tenantId,
  stageTag,
  store,
  customerId,
  skuIds,
  fixedSkuIds,
  reverseLineOrder,
  workerIndex,
  iterations
}) {
  const rng = createSeededRng(seedFromParts(stageTag, store.warehouseId, workerIndex));
  let attempted = 0;
  let succeeded = 0;
  let insufficient = 0;
  let exhausted = 0;
  let maxAttemptsPerOperationObserved = 1;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    attempted += 1;
    const [itemA, itemB] = fixedSkuIds
      ? fixedSkuIds
      : pickTwoDistinctSkuIds(rng, skuIds);
    const reverseReservationOrder = typeof reverseLineOrder === 'boolean'
      ? reverseLineOrder
      : ((workerIndex + iteration) % 2) === 1;
    const soNumber = `LD-${tenantId.slice(0, 8)}-${stageTag}-${store.index}-${workerIndex}-${iteration}`;

    try {
      const order = await createSalesOrder(tenantId, {
        soNumber,
        customerId,
        status: 'submitted',
        warehouseId: store.warehouseId,
        shipFromLocationId: store.sellableLocationId,
        lines: [
          { itemId: itemA, uom: 'each', quantityOrdered: 1 },
          { itemId: itemB, uom: 'each', quantityOrdered: 1 }
        ]
      });
      const lineA = order.lines[0];
      const lineB = order.lines[1];
      assert.ok(lineA?.id && lineB?.id, 'sales order must create line ids');

      const reservationLines = [
        {
          demandType: 'sales_order_line',
          demandId: lineA.id,
          itemId: itemA,
          warehouseId: store.warehouseId,
          locationId: store.sellableLocationId,
          uom: 'each',
          quantityReserved: 1,
          allowBackorder: false
        },
        {
          demandType: 'sales_order_line',
          demandId: lineB.id,
          itemId: itemB,
          warehouseId: store.warehouseId,
          locationId: store.sellableLocationId,
          uom: 'each',
          quantityReserved: 1,
          allowBackorder: false
        }
      ];
      if (reverseReservationOrder) {
        reservationLines.reverse();
      }

      await createReservations(
        tenantId,
        { reservations: reservationLines },
        { idempotencyKey: `ld-rsv-${stageTag}-${store.index}-${workerIndex}-${iteration}` }
      );
      succeeded += 1;
    } catch (error) {
      const code = error?.code ?? error?.cause?.code ?? null;
      if (code === 'ATP_INSUFFICIENT_AVAILABLE') {
        insufficient += 1;
        continue;
      }
      if (code === 'ATP_CONCURRENCY_EXHAUSTED') {
        exhausted += 1;
        const attempts = toFiniteNumber(error?.details?.attempts, 0);
        if (attempts > maxAttemptsPerOperationObserved) {
          maxAttemptsPerOperationObserved = attempts;
        }
        assert.ok(
          attempts <= CONFIG.maxAttemptsPerOperationCap,
          `ATP attempts must stay <= ${CONFIG.maxAttemptsPerOperationCap}, observed attempts=${attempts}`
        );
        continue;
      }
      throw error;
    }
  }

  return {
    warehouseId: store.warehouseId,
    attempted,
    succeeded,
    insufficient,
    exhausted,
    maxAttemptsPerOperationObserved
  };
}

async function runTransferWorker({
  tenantId,
  stageTag,
  factory,
  store,
  skuIds,
  workerIndex,
  iterations
}) {
  const rng = createSeededRng(seedFromParts(stageTag, 'transfer', store.warehouseId, workerIndex));
  let attempted = 0;
  let succeeded = 0;
  let insufficient = 0;
  let retryExhausted = 0;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    attempted += 1;
    const itemId = skuIds[pickIndex(rng, skuIds.length)];
    try {
      await postInventoryTransfer({
        tenantId,
        sourceLocationId: factory.sellableLocationId,
        destinationLocationId: store.sellableLocationId,
        itemId,
        quantity: 1,
        uom: 'each',
        reasonCode: 'phase43_replenish',
        notes: 'Phase 4.3 stress transfer',
        actorId: null,
        idempotencyKey: `ld-xfer-${stageTag}-${store.index}-${workerIndex}-${iteration}-${itemId}`
      });
      succeeded += 1;
    } catch (error) {
      const code = error?.code ?? error?.cause?.code ?? null;
      if (code === 'INSUFFICIENT_STOCK' || code === 'ATP_INSUFFICIENT_AVAILABLE') {
        insufficient += 1;
        continue;
      }
      if (code === 'TX_RETRY_EXHAUSTED') {
        retryExhausted += 1;
        continue;
      }
      throw error;
    }
  }

  return {
    warehouseId: store.warehouseId,
    attempted,
    succeeded,
    insufficient,
    retryExhausted
  };
}

function aggregateWorkerCounts(results, stores) {
  const attemptedByWarehouse = buildPerWarehouseMap(stores, 0);
  const succeededByWarehouse = buildPerWarehouseMap(stores, 0);
  const insufficientByWarehouse = buildPerWarehouseMap(stores, 0);
  const exhaustedByWarehouse = buildPerWarehouseMap(stores, 0);
  const retryExhaustedByWarehouse = buildPerWarehouseMap(stores, 0);
  let totalAttempted = 0;
  let totalSucceeded = 0;
  let totalInsufficient = 0;
  let totalExhausted = 0;
  let totalRetryExhausted = 0;
  let maxAttemptsPerOperationObserved = 1;

  for (const row of results) {
    attemptedByWarehouse.set(row.warehouseId, (attemptedByWarehouse.get(row.warehouseId) ?? 0) + row.attempted);
    succeededByWarehouse.set(row.warehouseId, (succeededByWarehouse.get(row.warehouseId) ?? 0) + row.succeeded);
    if ('insufficient' in row) {
      insufficientByWarehouse.set(
        row.warehouseId,
        (insufficientByWarehouse.get(row.warehouseId) ?? 0) + row.insufficient
      );
    }
    if ('exhausted' in row) {
      exhaustedByWarehouse.set(row.warehouseId, (exhaustedByWarehouse.get(row.warehouseId) ?? 0) + row.exhausted);
    }
    if ('retryExhausted' in row) {
      retryExhaustedByWarehouse.set(
        row.warehouseId,
        (retryExhaustedByWarehouse.get(row.warehouseId) ?? 0) + row.retryExhausted
      );
    }
    totalAttempted += row.attempted;
    totalSucceeded += row.succeeded;
    totalInsufficient += row.insufficient ?? 0;
    totalExhausted += row.exhausted ?? 0;
    totalRetryExhausted += row.retryExhausted ?? 0;
    maxAttemptsPerOperationObserved = Math.max(
      maxAttemptsPerOperationObserved,
      row.maxAttemptsPerOperationObserved ?? 1
    );
  }

  return {
    attemptedByWarehouse,
    succeededByWarehouse,
    insufficientByWarehouse,
    exhaustedByWarehouse,
    retryExhaustedByWarehouse,
    totalAttempted,
    totalSucceeded,
    totalInsufficient,
    totalExhausted,
    totalRetryExhausted,
    maxAttemptsPerOperationObserved
  };
}

async function runSalesPhase({
  tenantId,
  stageTag,
  stores,
  workersByWarehouseId,
  customerByWarehouseId,
  skuIds,
  fixedSkuIds,
  iterations
}) {
  const capture = createAtpMetricsCapture();
  __setAtpMetricsSinkForTests(capture.sink);
  const startedAt = performance.now();
  try {
    const workerTasks = [];
    for (const store of stores) {
      const workers = workersByWarehouseId.get(store.warehouseId) ?? 0;
      const customerId = customerByWarehouseId.get(store.warehouseId);
      assert.ok(customerId, `Missing customer for warehouse ${store.warehouseCode}`);
      for (let workerIndex = 0; workerIndex < workers; workerIndex += 1) {
        workerTasks.push(() =>
          runSalesWorker({
            tenantId,
            stageTag,
            store,
            customerId,
            skuIds,
            fixedSkuIds,
            reverseLineOrder: undefined,
            workerIndex,
            iterations
          })
        );
      }
    }
    const workerResults = await runWithConcurrency(workerTasks, workerTasks.length);
    const durationMs = performance.now() - startedAt;
    const sales = aggregateWorkerCounts(workerResults, stores);
    return {
      stageTag,
      durationMs,
      sales,
      metrics: capture.snapshot()
    };
  } finally {
    __setAtpMetricsSinkForTests(null);
  }
}

async function runMixedStressPhase({
  tenantId,
  stageTag,
  factory,
  stores,
  workersPerStore,
  transferWorkersPerStore,
  customerByWarehouseId,
  skuIds,
  iterations
}) {
  const capture = createAtpMetricsCapture();
  __setAtpMetricsSinkForTests(capture.sink);
  const startedAt = performance.now();
  try {
    const salesTasks = [];
    const transferTasks = [];
    const stressSkuPoolSize = Math.max(8, Math.floor(skuIds.length / Math.max(1, workersPerStore)));
    for (const store of stores) {
      const customerId = customerByWarehouseId.get(store.warehouseId);
      assert.ok(customerId, `Missing customer for warehouse ${store.warehouseCode}`);
      for (let workerIndex = 0; workerIndex < workersPerStore; workerIndex += 1) {
        const workerSkuPool = buildDeterministicSkuPool(
          skuIds,
          seedFromParts(stageTag, 'sales-pool', store.warehouseId, workerIndex),
          stressSkuPoolSize
        );
        salesTasks.push(() =>
          runSalesWorker({
            tenantId,
            stageTag,
            store,
            customerId,
            skuIds: workerSkuPool,
            reverseLineOrder: false,
            workerIndex,
            iterations
          })
        );
      }
      for (let workerIndex = 0; workerIndex < transferWorkersPerStore; workerIndex += 1) {
        const workerSkuPool = buildDeterministicSkuPool(
          skuIds,
          seedFromParts(stageTag, 'transfer-pool', store.warehouseId, workerIndex),
          stressSkuPoolSize
        );
        transferTasks.push(() =>
          runTransferWorker({
            tenantId,
            stageTag,
            factory,
            store,
            skuIds: workerSkuPool,
            workerIndex,
            iterations
          })
        );
      }
    }

    const [salesWorkerResults, transferWorkerResults] = await Promise.all([
      runWithConcurrency(salesTasks, salesTasks.length),
      runWithConcurrency(transferTasks, transferTasks.length)
    ]);
    const durationMs = performance.now() - startedAt;

    return {
      stageTag,
      durationMs,
      sales: aggregateWorkerCounts(salesWorkerResults, stores),
      transfers: aggregateWorkerCounts(transferWorkerResults, stores),
      metrics: capture.snapshot()
    };
  } finally {
    __setAtpMetricsSinkForTests(null);
  }
}

async function runStrictInvariantsForTenant(tenantId) {
  return execFileAsync(
    process.execPath,
    ['scripts/inventory_invariants_check.mjs', '--strict', '--tenant-id', tenantId, '--limit', '25'],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 4 * 1024 * 1024
    }
  );
}

let loadTenantIdForDebug = null;

test('multi-warehouse load: no oversell, warehouse isolation, bounded retries, strict invariants clean', {
  timeout: 900000
}, async () => {
  const { tenantId } = await createLoadTenant();
  loadTenantIdForDebug = tenantId;
  await provisionCanonicalTopology(tenantId);
  const { factory, stores } = await resolveWarehouseScopes(tenantId);
  const storesByWarehouseId = new Map(stores.map((store) => [store.warehouseId, store]));
  const customersByWarehouseId = await createStoreCustomers(tenantId, stores);
  const skuIds = await createSkuCatalog(tenantId, factory.sellableLocationId, CONFIG.skuCount);

  await seedInitialFactoryStock(tenantId, factory.sellableLocationId, skuIds, CONFIG.initialFactoryQtyPerSku);

  // Requirement B: initial stock is factory-only before any transfer workload.
  const preWarmupStoreStock = await query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_on_hand_location_v
      WHERE tenant_id = $1
        AND warehouse_id = ANY($2::uuid[])
        AND on_hand_qty > 0`,
    [tenantId, stores.map((store) => store.warehouseId)]
  );
  assert.equal(Number(preWarmupStoreStock.rows[0]?.count ?? 0), 0, 'store stock must be empty before transfer workload');

  await warmupStoreInventory({
    tenantId,
    factory,
    stores,
    skuIds,
    quantityPerSku: CONFIG.warmupQtyPerSku
  });

  const baselineStore = stores[1];
  const heavyStore = stores[0];
  const hotspotSkuIds = skuIds.slice(0, 2);
  assert.equal(hotspotSkuIds.length, 2, 'at least two SKUs are required for dual-store hotspot phase');
  const baselineWorkers = new Map([[baselineStore.warehouseId, CONFIG.workersPerStore * 3]]);
  const dualWorkers = new Map([
    [heavyStore.warehouseId, CONFIG.workersPerStore],
    [baselineStore.warehouseId, CONFIG.workersPerStore]
  ]);

  const baseline = await runSalesPhase({
    tenantId,
    stageTag: 'baseline',
    stores: [baselineStore],
    workersByWarehouseId: baselineWorkers,
    customerByWarehouseId: customersByWarehouseId,
    skuIds,
    fixedSkuIds: hotspotSkuIds,
    iterations: CONFIG.baselineIterations
  });

  const dual = await runSalesPhase({
    tenantId,
    stageTag: 'dual',
    stores: [heavyStore, baselineStore],
    workersByWarehouseId: dualWorkers,
    customerByWarehouseId: customersByWarehouseId,
    skuIds,
    fixedSkuIds: hotspotSkuIds,
    iterations: CONFIG.baselineIterations
  });

  const baselineThroughput = baseline.sales.totalSucceeded / (baseline.durationMs / 1000);
  const dualThroughput = dual.sales.totalSucceeded / (dual.durationMs / 1000);
  assert.ok(
    dualThroughput >= baselineThroughput * 1.7,
    `dual-store throughput should scale >=1.7x baseline (baseline=${baselineThroughput.toFixed(3)} ops/s dual=${dualThroughput.toFixed(3)} ops/s)`
  );

  const baselineStore2LockWaits = baseline.metrics.lockWaitByWarehouse.get(baselineStore.warehouseId) ?? [];
  const dualStore2LockWaits = dual.metrics.lockWaitByWarehouse.get(baselineStore.warehouseId) ?? [];
  const baselineStore2Avg = average(baselineStore2LockWaits);
  const dualStore2Avg = average(dualStore2LockWaits);
  const baselineStore2P95 = percentile(baselineStore2LockWaits, 0.95);
  const dualStore2P95 = percentile(dualStore2LockWaits, 0.95);

  assert.ok(
    dualStore2Avg <= Math.max(8, baselineStore2Avg * 1.5 + 5),
    `STORE_1 heavy load should not materially increase STORE_2 avg lock wait (baseline=${baselineStore2Avg.toFixed(3)}ms dual=${dualStore2Avg.toFixed(3)}ms)`
  );
  assert.ok(
    dualStore2P95 <= Math.max(20, baselineStore2P95 * 1.6 + 8),
    `STORE_1 heavy load should not materially increase STORE_2 p95 lock wait (baseline=${baselineStore2P95.toFixed(3)}ms dual=${dualStore2P95.toFixed(3)}ms)`
  );

  const stress = await runMixedStressPhase({
    tenantId,
    stageTag: 'stress',
    factory,
    stores,
    workersPerStore: CONFIG.workersPerStore,
    transferWorkersPerStore: CONFIG.transferWorkersPerStore,
    customerByWarehouseId: customersByWarehouseId,
    skuIds,
    iterations: CONFIG.stressIterations
  });

  const operationsTotal = stress.sales.totalAttempted + stress.transfers.totalAttempted;
  const retryAttemptsTotal = stress.metrics.retryAttemptsTotal;
  const avgRetriesPerOperation = retryAttemptsTotal / Math.max(1, operationsTotal);
  const retryAttemptsPer100Ops = avgRetriesPerOperation * 100;
  const exhaustionCount = Math.max(stress.sales.totalExhausted, stress.metrics.exhaustionEventCount);
  const exhaustionRatePct = (exhaustionCount / Math.max(1, operationsTotal)) * 100;
  const maxAttemptsPerOperationObserved = Math.max(
    stress.sales.maxAttemptsPerOperationObserved,
    stress.metrics.maxAttemptsPerOperationObserved,
    1
  );
  const maxRetriesPerOperationObserved = Math.max(0, maxAttemptsPerOperationObserved - 1);
  const perWarehouseThroughputMap = buildPerWarehouseMap(stores, 0);
  for (const store of stores) {
    const successes = (stress.sales.succeededByWarehouse.get(store.warehouseId) ?? 0)
      + (stress.transfers.succeededByWarehouse.get(store.warehouseId) ?? 0);
    perWarehouseThroughputMap.set(store.warehouseId, successes / (stress.durationMs / 1000));
  }

  const lockWaitByWarehouseSummary = {};
  for (const store of stores) {
    const waits = stress.metrics.lockWaitByWarehouse.get(store.warehouseId) ?? [];
    lockWaitByWarehouseSummary[store.warehouseCode] = {
      avgMs: roundMetric(average(waits)),
      p95Ms: roundMetric(percentile(waits, 0.95)),
      samples: waits.length
    };
  }

  const summary = {
    tenantId,
    operationsTotal,
    retryAttemptsTotal,
    avgRetriesPerOperation: roundMetric(avgRetriesPerOperation),
    retryAttemptsPer100Ops: roundMetric(retryAttemptsPer100Ops),
    maxAttemptsPerOperationObserved,
    maxRetriesPerOperationObserved,
    exhaustionCount,
    exhaustionRatePct: roundMetric(exhaustionRatePct),
    perWarehouseThroughput: Object.fromEntries(
      Object.entries(mapPerWarehouseByCode(storesByWarehouseId, perWarehouseThroughputMap)).map(([key, value]) => [
        key,
        roundMetric(value)
      ])
    ),
    avgLockWaitMs: roundMetric(stress.metrics.avgLockWaitMs),
    p95LockWaitMs: roundMetric(stress.metrics.p95LockWaitMs),
    atpConcurrencyExhaustedCount: exhaustionCount,
    transferRetryExhaustedCount: stress.transfers.totalRetryExhausted,
    lockWaitHistogramMs: stress.metrics.lockWaitHistogramMs,
    lockWaitHotspots: stress.metrics.lockWaitHotspots,
    lockWaitByWarehouse: lockWaitByWarehouseSummary
  };
  console.log(JSON.stringify({
    code: 'MULTI_WAREHOUSE_LOAD_SUMMARY',
    ...summary
  }));

  // This workload intentionally drives sustained serializable conflicts across
  // sales reservations and replenishment transfers. Correctness is guarded by
  // the invariant checks below and the bounded retry assertions above, so allow
  // a small non-zero exhaustion rate for slower CI runners.
  assert.ok(
    exhaustionRatePct < 2,
    `ATP_CONCURRENCY_EXHAUSTED rate must stay <2.0% (rate=${exhaustionRatePct.toFixed(4)}%)`
  );
  assert.equal(
    maxRetriesPerOperationObserved,
    Math.max(0, maxAttemptsPerOperationObserved - 1),
    'maxRetriesPerOperationObserved must equal maxAttemptsPerOperationObserved - 1'
  );
  assert.ok(
    maxAttemptsPerOperationObserved <= CONFIG.maxAttemptsPerOperationCap,
    `ATP attempts must stay <= ${CONFIG.maxAttemptsPerOperationCap} (observed=${maxAttemptsPerOperationObserved})`
  );
  assert.ok(
    retryAttemptsTotal <= stress.sales.totalAttempted * Math.max(1, CONFIG.maxAttemptsPerOperationCap - 1),
    `retry attempt event count exceeded bounded maximum (events=${retryAttemptsTotal}, sales=${stress.sales.totalAttempted}, maxAttempts=${CONFIG.maxAttemptsPerOperationCap})`
  );

  const strictInvariantRun = await runStrictInvariantsForTenant(tenantId);
  const invariantStdout = strictInvariantRun.stdout;
  assert.equal(getInvariantCount(invariantStdout, 'atp_oversell_detected'), 0);
  assert.equal(getInvariantCount(invariantStdout, 'negative_on_hand'), 0);
  assert.equal(getInvariantCount(invariantStdout, 'unmatched_cost_layers'), 0);
  assert.equal(getInvariantCount(invariantStdout, 'orphaned_cost_layers'), 0);
  assert.equal(getInvariantCount(invariantStdout, 'warehouse_default_completeness_invalid'), 0);

  console.log(`[multi_warehouse_load_tenant_id] ${tenantId}`);
});

test.after(async () => {
  __setAtpMetricsSinkForTests(null);
  sharedDbPool.options.allowExitOnIdle = true;
  if (loadTenantIdForDebug) {
    console.log(`[multi_warehouse_load_last_tenant_id] ${loadTenantIdForDebug}`);
  }
});
