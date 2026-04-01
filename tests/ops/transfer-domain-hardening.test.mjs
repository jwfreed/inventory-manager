import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServiceHarness } from './helpers/service-harness.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  prepareTransferMutation
} = require('../../src/domain/transfers/transferPolicy.ts');
const {
  buildTransferMovementPlan
} = require('../../src/domain/transfers/transferPlan.ts');
const {
  createUomConversion
} = require('../../src/services/masterData.service.ts');

async function createTransferFixture(label) {
  const harness = await createServiceHarness({
    tenantPrefix: label,
    tenantName: `Transfer Hardening ${label}`
  });
  const factory = harness.topology;
  const store = await harness.createWarehouseWithSellable(`STORE-${randomUUID().slice(0, 6)}`);
  const item = await harness.createItem({
    defaultLocationId: factory.defaults.SELLABLE.id,
    skuPrefix: 'ITEM',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: factory.warehouse.id,
    itemId: item.id,
    locationId: factory.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });
  return {
    harness,
    factory,
    store,
    itemId: item.id
  };
}

async function expectCode(action, expectedCode) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.code ?? error?.message, expectedCode);
    return true;
  });
}

function buildPolicyTx(config = {}) {
  const sourceLocationId = config.sourceLocationId ?? 'source-location';
  const destinationLocationId = config.destinationLocationId ?? 'destination-location';
  const sourceWarehouseId = config.sourceWarehouseId ?? 'warehouse-a';
  const destinationWarehouseId = config.destinationWarehouseId ?? sourceWarehouseId;
  const readinessByLocation = new Map([
    [sourceLocationId, config.sourceReady ?? true],
    [destinationLocationId, config.destinationReady ?? true]
  ]);
  const roleByLocation = new Map([
    [
      sourceLocationId,
      {
        role: config.sourceRole ?? 'QA',
        is_sellable: config.sourceSellable ?? false
      }
    ],
    [
      destinationLocationId,
      {
        role: config.destinationRole ?? 'SELLABLE',
        is_sellable: config.destinationSellable ?? true
      }
    ]
  ]);
  const locationTree = new Map([
    [sourceLocationId, { id: sourceLocationId, type: 'bin', parent_location_id: sourceWarehouseId }],
    [destinationLocationId, { id: destinationLocationId, type: 'bin', parent_location_id: destinationWarehouseId }],
    [sourceWarehouseId, { id: sourceWarehouseId, type: 'warehouse', parent_location_id: null }],
    [destinationWarehouseId, { id: destinationWarehouseId, type: 'warehouse', parent_location_id: null }]
  ]);

  return {
    async query(sql, params) {
      if (/SELECT id, type, parent_location_id/.test(sql)) {
        const row = locationTree.get(params[0]) ?? null;
        return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
      }
      if (/SELECT COUNT\(\*\)::text AS bin_count/.test(sql)) {
        const ready = readinessByLocation.get(params[1]) ?? false;
        return {
          rowCount: 1,
          rows: [
            ready
              ? { bin_count: '1', default_count: '1', default_bin_id: `default-${params[1]}` }
              : { bin_count: '0', default_count: '0', default_bin_id: null }
          ]
        };
      }
      if (/SELECT role, is_sellable/.test(sql)) {
        const row = roleByLocation.get(params[0]) ?? null;
        return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
      }
      throw new Error(`UNEXPECTED_QUERY ${sql}`);
    }
  };
}

function withNegativeOverrideEnv(values, action) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return Promise.resolve()
    .then(action)
    .finally(() => {
      for (const [key, value] of previous.entries()) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

test('transfer planning is deterministic and enforces location-level quantity, uom, and direction invariants', async () => {
  const { harness, factory, store, itemId } = await createTransferFixture('transfer-plan-invariants');
  const client = await harness.pool.connect();
  try {
    const input = {
      tenantId: harness.tenantId,
      sourceLocationId: factory.defaults.SELLABLE.id,
      destinationLocationId: store.sellable.id,
      itemId,
      quantity: 3,
      uom: 'each',
      sourceType: 'inventory_transfer',
      sourceId: 'fixed-source',
      movementType: 'transfer',
      reasonCode: 'hardening',
      notes: 'Location-level transfer',
      occurredAt: new Date('2026-04-01T00:00:00.000Z')
    };
    const prepared = await prepareTransferMutation(input, client);
    const planA = await buildTransferMovementPlan(prepared, client);
    const planB = await buildTransferMovementPlan(prepared, client);

    assert.equal('sourceDefaultBinId' in prepared, false);
    assert.equal('destinationDefaultBinId' in prepared, false);
    assert.equal(planA.expectedDeterministicHash, planB.expectedDeterministicHash);
    assert.equal(planA.expectedLineCount, 2);
    assert.equal(planA.lines.length, 2);

    const outbound = planA.lines.find((line) => line.direction === 'out');
    const inbound = planA.lines.find((line) => line.direction === 'in');
    assert.ok(outbound);
    assert.ok(inbound);
    assert.ok(outbound.canonicalFields.quantityDeltaCanonical < 0);
    assert.ok(inbound.canonicalFields.quantityDeltaCanonical > 0);
    assert.equal(outbound.canonicalFields.canonicalUom, inbound.canonicalFields.canonicalUom);
    assert.equal(
      Math.abs(outbound.canonicalFields.quantityDeltaCanonical),
      inbound.canonicalFields.quantityDeltaCanonical
    );
    assert.equal(outbound.locationId, factory.defaults.SELLABLE.id);
    assert.equal(inbound.locationId, store.sellable.id);
  } finally {
    client.release();
  }
});

test('transfer policy rejects same-location transfers', async () => {
  const { harness, factory, itemId } = await createTransferFixture('transfer-same-location');
  await expectCode(
    () =>
      harness.postTransfer({
        sourceLocationId: factory.defaults.SELLABLE.id,
        destinationLocationId: factory.defaults.SELLABLE.id,
        itemId,
        quantity: 1,
        uom: 'each',
        idempotencyKey: `same-location-${randomUUID()}`
      }),
    'TRANSFER_SAME_LOCATION'
  );
});

test('transfer policy rejects explicit warehouse scope mismatches', async () => {
  const { harness, factory, store, itemId } = await createTransferFixture('transfer-warehouse-mismatch');
  await expectCode(
    () =>
      harness.postTransfer({
        sourceLocationId: factory.defaults.SELLABLE.id,
        destinationLocationId: store.sellable.id,
        warehouseId: factory.warehouse.id,
        itemId,
        quantity: 1,
        uom: 'each',
        idempotencyKey: `warehouse-mismatch-${randomUUID()}`
      }),
    'WAREHOUSE_SCOPE_MISMATCH'
  );
});

test('transfer policy rejects non-inventory-ready locations', async () => {
  const { harness, factory, store, itemId } = await createTransferFixture('transfer-location-not-ready');
  await harness.pool.query(
    `DELETE FROM inventory_bins
      WHERE tenant_id = $1
        AND location_id = $2`,
    [harness.tenantId, store.sellable.id]
  );

  await expectCode(
    () =>
      harness.postTransfer({
        sourceLocationId: factory.defaults.SELLABLE.id,
        destinationLocationId: store.sellable.id,
        itemId,
        quantity: 1,
        uom: 'each',
        idempotencyKey: `location-not-ready-${randomUUID()}`
      }),
    'LOCATION_INVENTORY_NOT_READY'
  );
});

test('transfer policy enforces QC accept, hold, and reject paths', async () => {
  const baseInput = {
    tenantId: 'tenant-1',
    sourceLocationId: 'source-location',
    destinationLocationId: 'destination-location',
    itemId: 'item-1',
    quantity: 1,
    uom: 'each',
    sourceType: 'qc_event',
    sourceId: 'qc-1',
    movementType: 'transfer',
    occurredAt: new Date('2026-04-01T00:00:00.000Z')
  };

  await assert.doesNotReject(() =>
    prepareTransferMutation(
      {
        ...baseInput,
        qcAction: 'accept'
      },
      buildPolicyTx({
        destinationRole: 'SELLABLE',
        destinationSellable: true
      })
    )
  );

  await assert.doesNotReject(() =>
    prepareTransferMutation(
      {
        ...baseInput,
        qcAction: 'hold'
      },
      buildPolicyTx({
        destinationRole: 'HOLD',
        destinationSellable: false
      })
    )
  );

  await assert.doesNotReject(() =>
    prepareTransferMutation(
      {
        ...baseInput,
        qcAction: 'reject'
      },
      buildPolicyTx({
        destinationRole: 'REJECT',
        destinationSellable: false
      })
    )
  );
});

test('transfer execution preserves created and replayed behavior with deterministic replay integrity', async () => {
  const { harness, factory, store, itemId } = await createTransferFixture('transfer-created-replayed');
  const idempotencyKey = `transfer-replay-${randomUUID()}`;
  const occurredAt = new Date('2026-04-01T00:00:00.000Z');
  const payload = {
    sourceLocationId: factory.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId,
    quantity: 2,
    uom: 'each',
    occurredAt,
    reasonCode: 'hardening',
    notes: 'Created vs replayed',
    idempotencyKey
  };

  const created = await harness.postTransfer(payload);
  const replayed = await harness.postTransfer(payload);

  assert.equal(created.replayed, false);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.movementId, created.movementId);

  const movementResult = await harness.pool.query(
    `SELECT movement_deterministic_hash
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2`,
    [harness.tenantId, created.movementId]
  );
  assert.ok(movementResult.rows[0]?.movement_deterministic_hash);

  const lineCountResult = await harness.pool.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2`,
    [harness.tenantId, created.movementId]
  );
  assert.equal(Number(lineCountResult.rows[0]?.count ?? 0), 2);
});

test('transfer execution conserves cost layer quantity and value across relocation', async () => {
  const { harness, factory, store, itemId } = await createTransferFixture('transfer-cost-conservation');
  const transfer = await harness.postTransfer({
    sourceLocationId: factory.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId,
    quantity: 4,
    uom: 'each',
    reasonCode: 'cost_conservation',
    notes: 'Cost conservation',
    idempotencyKey: `cost-${randomUUID()}`
  });

  const lineResult = await harness.pool.query(
    `SELECT id, quantity_delta
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
      ORDER BY quantity_delta ASC`,
    [harness.tenantId, transfer.movementId]
  );
  assert.equal(lineResult.rowCount, 2);
  const outLineId = lineResult.rows[0].id;
  const inLineId = lineResult.rows[1].id;

  const [linkTotals, consumptionTotals, destTotals] = await Promise.all([
    harness.pool.query(
      `SELECT COALESCE(SUM(quantity), 0)::text AS quantity,
              COALESCE(SUM(extended_cost), 0)::text AS extended_cost
         FROM cost_layer_transfer_links
        WHERE tenant_id = $1
          AND transfer_movement_id = $2
          AND transfer_out_line_id = $3
          AND transfer_in_line_id = $4`,
      [harness.tenantId, transfer.movementId, outLineId, inLineId]
    ),
    harness.pool.query(
      `SELECT COALESCE(SUM(consumed_quantity), 0)::text AS quantity,
              COALESCE(SUM(extended_cost), 0)::text AS extended_cost
         FROM cost_layer_consumptions
        WHERE tenant_id = $1
          AND movement_id = $2
          AND consumption_document_id = $3`,
      [harness.tenantId, transfer.movementId, outLineId]
    ),
    harness.pool.query(
      `SELECT COALESCE(SUM(original_quantity), 0)::text AS quantity,
              COALESCE(SUM(extended_cost), 0)::text AS extended_cost
         FROM inventory_cost_layers
        WHERE tenant_id = $1
          AND movement_id = $2
          AND source_type = 'transfer_in'
          AND source_document_id = $3
          AND voided_at IS NULL`,
      [harness.tenantId, transfer.movementId, inLineId]
    )
  ]);

  assert.equal(Number(linkTotals.rows[0].quantity), 4);
  assert.equal(Number(consumptionTotals.rows[0].quantity), 4);
  assert.equal(Number(destTotals.rows[0].quantity), 4);
  assert.equal(Number(linkTotals.rows[0].extended_cost), Number(consumptionTotals.rows[0].extended_cost));
  assert.equal(Number(linkTotals.rows[0].extended_cost), Number(destTotals.rows[0].extended_cost));
});

test('transfer planning preserves canonical rounding boundaries', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'transfer-rounding',
    tenantName: 'Transfer Rounding'
  });
  const store = await harness.createWarehouseWithSellable(`STORE-${randomUUID().slice(0, 6)}`);
  const item = await harness.createItem({
    defaultLocationId: harness.topology.defaults.SELLABLE.id,
    skuPrefix: 'MASS',
    type: 'raw',
    defaultUom: 'kg',
    canonicalUom: 'g',
    stockingUom: 'kg',
    uomDimension: 'mass'
  });
  await createUomConversion(harness.tenantId, {
    itemId: item.id,
    fromUom: 'kg',
    toUom: 'g',
    factor: 1000
  });
  await createUomConversion(harness.tenantId, {
    itemId: item.id,
    fromUom: 'g',
    toUom: 'kg',
    factor: 0.001
  });

  const client = await harness.pool.connect();
  try {
    const prepared = await prepareTransferMutation(
      {
        tenantId: harness.tenantId,
        sourceLocationId: harness.topology.defaults.SELLABLE.id,
        destinationLocationId: store.sellable.id,
        itemId: item.id,
        quantity: 0.001,
        uom: 'kg',
        sourceType: 'inventory_transfer',
        sourceId: 'rounding-source',
        movementType: 'transfer',
        occurredAt: new Date('2026-04-01T00:00:00.000Z')
      },
      client
    );
    const plan = await buildTransferMovementPlan(prepared, client);
    assert.equal(plan.canonicalQuantity, 1);
    assert.equal(plan.canonicalUom, 'g');
  } finally {
    client.release();
  }
});

test('transfer execution honors negative override when explicitly enabled', async () => {
  await withNegativeOverrideEnv(
    {
      ALLOW_NEGATIVE_INVENTORY: 'false',
      ALLOW_NEGATIVE_WITH_OVERRIDE: 'true',
      NEGATIVE_OVERRIDE_REQUIRES_REASON: 'true',
      NEGATIVE_OVERRIDE_REQUIRES_ROLE: 'false'
    },
    async () => {
      const harness = await createServiceHarness({
        tenantPrefix: 'transfer-negative-override',
        tenantName: 'Transfer Negative Override'
      });
      const store = await harness.createWarehouseWithSellable(`STORE-${randomUUID().slice(0, 6)}`);
      const item = await harness.createItem({
        defaultLocationId: harness.topology.defaults.SELLABLE.id,
        skuPrefix: 'NEG',
        type: 'raw'
      });

      await expectCode(
        () =>
          harness.postTransfer({
            sourceLocationId: harness.topology.defaults.SELLABLE.id,
            destinationLocationId: store.sellable.id,
            itemId: item.id,
            quantity: 2,
            uom: 'each',
            overrideNegative: true,
            idempotencyKey: `negative-override-${randomUUID()}`
          }),
        'NEGATIVE_OVERRIDE_REQUIRES_REASON'
      );
    }
  );
});
