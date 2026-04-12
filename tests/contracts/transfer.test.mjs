import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { assertMovementContract } from './helpers/mutationContract.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { recordAuditLog } = require('../../src/lib/audit.ts');
const { transferInventory } = require('../../src/services/transfers.service.ts');
const { withInventoryTransaction } = require('../../src/modules/platform/application/withInventoryTransaction.ts');

const FIXED_OCCURRED_AT = new Date('2026-04-10T12:00:00.000Z');
const TRANSFERS_SERVICE = path.resolve(process.cwd(), 'src/services/transfers.service.ts');

test('transfer contract writes ledger, emits events, updates projections, and replays cleanly', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'contract-transfer', tenantName: 'Contract Transfer' });
  const { topology } = harness;
  const store = await harness.createWarehouseWithSellable('CONTRACT-STORE');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'TRANSFER',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5
  });
  const transfer = await harness.postTransfer({
    sourceLocationId: topology.defaults.SELLABLE.id,
    destinationLocationId: store.sellable.id,
    itemId: item.id,
    quantity: 4,
    uom: 'each',
    reasonCode: 'contract_transfer',
    notes: 'contract transfer',
    idempotencyKey: 'contract-transfer'
  });

  await assertMovementContract({
    harness,
    movementId: transfer.movementId,
    expectedMovementType: 'transfer',
    expectedSourceType: 'inventory_transfer',
    expectedLineCount: 2,
    expectedBalances: [
      { itemId: item.id, locationId: topology.defaults.SELLABLE.id, onHand: 6 },
      { itemId: item.id, locationId: store.sellable.id, onHand: 4 }
    ]
  });
});

test('transfer path parity persists equivalent state for standalone and external-client execution', { timeout: 120000 }, async () => {
  const standaloneWorld = await createTransferWorld('contract-transfer-parity-standalone');
  const externalWorld = await createTransferWorld('contract-transfer-parity-external');
  const sourceId = 'transfer-path-parity';

  const standaloneInput = buildTransferInput(standaloneWorld, {
    idempotencyKey: `transfer-parity-standalone:${randomUUID()}`,
    sourceId
  });
  const externalInput = buildTransferInput(externalWorld, {
    idempotencyKey: `transfer-parity-external:${randomUUID()}`,
    sourceId
  });

  const standalone = await transferInventory(standaloneInput);
  const external = await withInventoryTransaction((client) =>
    transferInventory(externalInput, { client })
  );

  assert.equal(standalone.created, true);
  assert.equal(standalone.replayed, false);
  assert.equal(external.created, true);
  assert.equal(external.replayed, false);

  const standaloneState = await snapshotTransferState(standaloneWorld, standalone, standaloneInput.idempotencyKey);
  const externalState = await snapshotTransferState(externalWorld, external, externalInput.idempotencyKey);
  assert.deepEqual(standaloneState, externalState);
});

test('transfer replay parity returns equivalent replay responses with zero new writes', { timeout: 120000 }, async () => {
  const standaloneWorld = await createTransferWorld('contract-transfer-replay-standalone');
  const externalWorld = await createTransferWorld('contract-transfer-replay-external');

  const standaloneInput = buildTransferInput(standaloneWorld, {
    idempotencyKey: `transfer-replay-standalone:${randomUUID()}`,
    sourceId: 'transfer-replay-parity'
  });
  const externalInput = buildTransferInput(externalWorld, {
    idempotencyKey: `transfer-replay-external:${randomUUID()}`,
    sourceId: 'transfer-replay-parity'
  });

  const standaloneFirst = await transferInventory(standaloneInput);
  const externalFirst = await withInventoryTransaction((client) =>
    transferInventory(externalInput, { client })
  );
  const standaloneCountsBeforeReplay = await countTransferWrites(standaloneWorld, standaloneInput);
  const externalCountsBeforeReplay = await countTransferWrites(externalWorld, externalInput);

  const standaloneReplay = await transferInventory(standaloneInput);
  const externalReplay = await withInventoryTransaction((client) =>
    transferInventory(externalInput, { client })
  );

  assert.equal(standaloneReplay.replayed, true);
  assert.equal(externalReplay.replayed, true);
  assert.equal(standaloneReplay.movementId, standaloneFirst.movementId);
  assert.equal(externalReplay.movementId, externalFirst.movementId);
  assert.deepEqual(
    normalizeTransferResponse(standaloneWorld, standaloneReplay),
    normalizeTransferResponse(externalWorld, externalReplay)
  );
  assert.deepEqual(await countTransferWrites(standaloneWorld, standaloneInput), standaloneCountsBeforeReplay);
  assert.deepEqual(await countTransferWrites(externalWorld, externalInput), externalCountsBeforeReplay);

  const standaloneState = await snapshotTransferState(standaloneWorld, standaloneFirst, standaloneInput.idempotencyKey);
  const externalState = await snapshotTransferState(externalWorld, externalFirst, externalInput.idempotencyKey);
  assert.deepEqual(standaloneState, externalState);
});

test('external-client transfer rolls back movement audit and idempotency finalization before commit', { timeout: 120000 }, async () => {
  const world = await createTransferWorld('contract-transfer-rollback');
  const input = buildTransferInput(world, {
    idempotencyKey: `transfer-rollback:${randomUUID()}`,
    sourceId: 'transfer-rollback-probe'
  });
  const auditEntityType = 'transfer_rollback_probe';

  await assert.rejects(
    withInventoryTransaction(async (client) => {
      const transfer = await transferInventory(input, { client });
      await recordAuditLog(
        {
          tenantId: world.harness.tenantId,
          actorType: 'system',
          actorId: null,
          action: 'post',
          entityType: auditEntityType,
          entityId: transfer.movementId,
          metadata: { probe: true }
        },
        client
      );
      throw new Error('TRANSFER_ROLLBACK_PROBE');
    }),
    /TRANSFER_ROLLBACK_PROBE/
  );

  assert.deepEqual(await countTransferWrites(world, input), {
    movements: 0,
    lines: 0,
    events: 0,
    idempotencyRows: 0
  });
  assert.equal(await countAuditRows(world, auditEntityType), 0);

  const retry = await withInventoryTransaction((client) =>
    transferInventory(input, { client })
  );
  assert.equal(retry.created, true);
  assert.equal(retry.replayed, false);
  assert.equal((await countTransferWrites(world, input)).movements, 1);
});

test('transfer orchestration source and persisted event order stay unified across paths', { timeout: 120000 }, async () => {
  await assertSingleTransferOrchestrationSource();

  const standaloneWorld = await createTransferWorld('contract-transfer-order-standalone');
  const externalWorld = await createTransferWorld('contract-transfer-order-external');
  const standaloneInput = buildTransferInput(standaloneWorld, {
    idempotencyKey: `transfer-order-standalone:${randomUUID()}`,
    sourceId: 'transfer-order-invariant'
  });
  const externalInput = buildTransferInput(externalWorld, {
    idempotencyKey: `transfer-order-external:${randomUUID()}`,
    sourceId: 'transfer-order-invariant'
  });

  const standalone = await transferInventory(standaloneInput);
  const external = await withInventoryTransaction((client) =>
    transferInventory(externalInput, { client })
  );
  const standaloneState = await snapshotTransferState(standaloneWorld, standalone, standaloneInput.idempotencyKey);
  const externalState = await snapshotTransferState(externalWorld, external, externalInput.idempotencyKey);

  assert.deepEqual(standaloneState.events.map((event) => event.eventType), externalState.events.map((event) => event.eventType));
  assert.equal(standaloneState.movement.count, 1);
  assert.equal(externalState.movement.count, 1);
  assert.ok(standaloneState.events.length > 0);
  assert.ok(externalState.events.length > 0);
  assert.equal(standaloneState.projection.inventoryBalance.length, 2);
  assert.equal(externalState.projection.inventoryBalance.length, 2);
  assert.equal(standaloneState.idempotency.status, 'SUCCEEDED');
  assert.equal(externalState.idempotency.status, 'SUCCEEDED');
});

async function createTransferWorld(prefix) {
  const harness = await createServiceHarness({
    tenantPrefix: prefix,
    tenantName: prefix
  });
  const destination = await harness.createWarehouseWithSellable(`${prefix.toUpperCase().slice(0, 18)}-DST`);
  const item = await harness.createItem({
    defaultLocationId: harness.topology.defaults.SELLABLE.id,
    skuPrefix: prefix.toUpperCase().slice(0, 18),
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: harness.topology.warehouse.id,
    itemId: item.id,
    locationId: harness.topology.defaults.SELLABLE.id,
    quantity: 10,
    unitCost: 5,
    countedAt: '2026-04-01T00:00:00.000Z'
  });
  return {
    harness,
    item,
    sourceLocationId: harness.topology.defaults.SELLABLE.id,
    sourceWarehouseId: harness.topology.warehouse.id,
    destinationLocationId: destination.sellable.id,
    destinationWarehouseId: destination.warehouse.id
  };
}

function buildTransferInput(world, { idempotencyKey, sourceId }) {
  return {
    tenantId: world.harness.tenantId,
    sourceLocationId: world.sourceLocationId,
    destinationLocationId: world.destinationLocationId,
    warehouseId: null,
    itemId: world.item.id,
    quantity: 4,
    uom: 'each',
    sourceType: 'inventory_transfer',
    sourceId,
    movementType: 'transfer',
    reasonCode: 'contract_transfer',
    notes: 'contract transfer',
    occurredAt: FIXED_OCCURRED_AT,
    actorId: null,
    overrideNegative: false,
    overrideReason: null,
    idempotencyKey
  };
}

async function snapshotTransferState(world, result, idempotencyKey) {
  const { pool: db, tenantId } = world.harness;
  const movement = await db.query(
    `SELECT id,
            tenant_id,
            movement_type,
            status,
            external_ref,
            source_type,
            source_id,
            idempotency_key,
            occurred_at,
            posted_at,
            notes,
            metadata,
            movement_deterministic_hash
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, result.movementId]
  );
  assert.equal(movement.rowCount, 1);
  assert.match(movement.rows[0].movement_deterministic_hash ?? '', /^[a-f0-9]{64}$/);

  const lines = await db.query(
    `SELECT item_id,
            location_id,
            quantity_delta::numeric AS quantity_delta,
            uom,
            quantity_delta_entered::numeric AS quantity_delta_entered,
            uom_entered,
            quantity_delta_canonical::numeric AS quantity_delta_canonical,
            canonical_uom,
            uom_dimension,
            unit_cost::numeric AS unit_cost,
            extended_cost::numeric AS extended_cost,
            reason_code,
            line_notes
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
      ORDER BY quantity_delta ASC, location_id ASC`,
    [tenantId, result.movementId]
  );

  const events = await db.query(
    `SELECT aggregate_type,
            aggregate_id,
            event_type,
            event_version,
            payload,
            producer_idempotency_key
       FROM inventory_events
      WHERE tenant_id = $1
        AND producer_idempotency_key = $2
      ORDER BY event_seq ASC`,
    [tenantId, idempotencyKey]
  );

  const balance = await db.query(
    `SELECT item_id,
            location_id,
            uom,
            on_hand::numeric AS on_hand,
            reserved::numeric AS reserved,
            allocated::numeric AS allocated
       FROM inventory_balance
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = ANY($3::uuid[])
      ORDER BY location_id ASC`,
    [tenantId, world.item.id, [world.sourceLocationId, world.destinationLocationId]]
  );

  const idempotency = await db.query(
    `SELECT key,
            endpoint,
            request_hash,
            response_status,
            response_body,
            status,
            response_ref
       FROM idempotency_keys
      WHERE tenant_id = $1
        AND key = $2`,
    [tenantId, idempotencyKey]
  );
  assert.equal(idempotency.rowCount, 1);

  return {
    movement: {
      count: movement.rowCount,
      row: {
        movementType: movement.rows[0].movement_type,
        status: movement.rows[0].status,
        externalRef: normalizeVolatileText(movement.rows[0].external_ref, idempotencyKey),
        sourceType: movement.rows[0].source_type,
        sourceId: movement.rows[0].source_id,
        idempotencyKey: '<key>',
        occurredAt: new Date(movement.rows[0].occurred_at).toISOString(),
        posted: movement.rows[0].posted_at !== null,
        notes: movement.rows[0].notes,
        metadata: movement.rows[0].metadata ?? null,
        movementDeterministicHash: '<sha256>'
      }
    },
    lines: lines.rows.map((row) => ({
      itemId: '<item>',
      location: labelLocation(world, row.location_id),
      quantityDelta: toNumeric(row.quantity_delta),
      uom: row.uom,
      quantityDeltaEntered: toNullableNumeric(row.quantity_delta_entered),
      uomEntered: row.uom_entered,
      quantityDeltaCanonical: toNullableNumeric(row.quantity_delta_canonical),
      canonicalUom: row.canonical_uom,
      uomDimension: row.uom_dimension,
      unitCost: toNullableNumeric(row.unit_cost),
      extendedCost: toNullableNumeric(row.extended_cost),
      reasonCode: row.reason_code,
      lineNotes: row.line_notes
    })),
    events: events.rows.map((row) => ({
      aggregateType: row.aggregate_type,
      aggregateId: normalizeId(world, row.aggregate_id, result.movementId),
      eventType: row.event_type,
      eventVersion: row.event_version,
      payload: normalizePayload(world, row.payload ?? {}, result.movementId),
      producerIdempotencyKey: '<key>'
    })),
    projection: {
      inventoryBalance: balance.rows.map((row) => ({
        itemId: '<item>',
        location: labelLocation(world, row.location_id),
        uom: row.uom,
        onHand: toNumeric(row.on_hand),
        reserved: toNumeric(row.reserved),
        allocated: toNumeric(row.allocated)
      })).sort((left, right) => left.location.localeCompare(right.location))
    },
    idempotency: {
      key: '<key>',
      endpoint: idempotency.rows[0].endpoint,
      requestHash: '<sha256>',
      responseStatus: idempotency.rows[0].response_status,
      responseBody: normalizeTransferResponse(world, idempotency.rows[0].response_body),
      status: idempotency.rows[0].status,
      responseRef: idempotency.rows[0].response_ref
    }
  };
}

async function countTransferWrites(world, input) {
  const { pool: db, tenantId } = world.harness;
  const result = await db.query(
    `WITH transfer_movements AS (
       SELECT id
         FROM inventory_movements
        WHERE tenant_id = $1
          AND source_type = $2
          AND source_id = $3
     )
     SELECT (SELECT COUNT(*)::int FROM transfer_movements) AS movements,
            (SELECT COUNT(*)::int
               FROM inventory_movement_lines l
               JOIN transfer_movements m ON m.id = l.movement_id
              WHERE l.tenant_id = $1) AS lines,
            (SELECT COUNT(*)::int
               FROM inventory_events
              WHERE tenant_id = $1
                AND producer_idempotency_key = $4) AS events,
            (SELECT COUNT(*)::int
               FROM idempotency_keys
              WHERE tenant_id = $1
                AND key = $4) AS idempotency_rows`,
    [tenantId, input.sourceType, input.sourceId, input.idempotencyKey]
  );
  return {
    movements: Number(result.rows[0].movements),
    lines: Number(result.rows[0].lines),
    events: Number(result.rows[0].events),
    idempotencyRows: Number(result.rows[0].idempotency_rows)
  };
}

async function countAuditRows(world, entityType) {
  const result = await world.harness.pool.query(
    `SELECT COUNT(*)::int AS count
       FROM audit_log
      WHERE tenant_id = $1
        AND entity_type = $2`,
    [world.harness.tenantId, entityType]
  );
  return Number(result.rows[0].count);
}

function normalizeTransferResponse(world, response) {
  return {
    movementId: '<movement>',
    created: response.created,
    replayed: response.replayed,
    idempotencyKey: response.idempotencyKey ? '<key>' : null,
    sourceWarehouseId: response.sourceWarehouseId === world.sourceWarehouseId ? '<sourceWarehouse>' : '<warehouse>',
    destinationWarehouseId: response.destinationWarehouseId === world.destinationWarehouseId ? '<destinationWarehouse>' : '<warehouse>'
  };
}

function normalizePayload(world, payload, movementId) {
  return replaceIds(payload, {
    [movementId]: '<movement>',
    [world.item.id]: '<item>',
    [world.sourceLocationId]: '<sourceLocation>',
    [world.destinationLocationId]: '<destinationLocation>',
    [world.sourceWarehouseId]: '<sourceWarehouse>',
    [world.destinationWarehouseId]: '<destinationWarehouse>'
  });
}

function normalizeId(world, value, movementId) {
  const text = String(value);
  if (text === movementId) return '<movement>';
  if (text === world.item.id) return '<item>';
  if (text === world.sourceLocationId) return '<sourceLocation>';
  if (text === world.destinationLocationId) return '<destinationLocation>';
  if (text === world.sourceWarehouseId) return '<sourceWarehouse>';
  if (text === world.destinationWarehouseId) return '<destinationWarehouse>';
  return '<id>';
}

function replaceIds(value, replacements) {
  if (Array.isArray(value)) {
    return value.map((entry) => replaceIds(entry, replacements));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, replaceIds(entry, replacements)])
    );
  }
  if (typeof value === 'string') {
    return replacements[value] ?? value;
  }
  return value;
}

function labelLocation(world, locationId) {
  if (String(locationId) === world.sourceLocationId) return 'source';
  if (String(locationId) === world.destinationLocationId) return 'destination';
  return 'unknown';
}

function normalizeVolatileText(value, idempotencyKey) {
  if (typeof value !== 'string') return value;
  return value.replace(idempotencyKey, '<key>');
}

function toNumeric(value) {
  return Number(value ?? 0);
}

function toNullableNumeric(value) {
  return value === null || value === undefined ? null : Number(value);
}

async function assertSingleTransferOrchestrationSource() {
  const source = await readFile(TRANSFERS_SERVICE, 'utf8');
  assert.equal((source.match(/\basync function executeTransferWithClient\b/g) ?? []).length, 1);
  assert.equal((source.match(/\bexecuteTransferWithExternalClient\b/g) ?? []).length, 0);

  const executorBody = extractFunctionBody(source, 'executeTransferWithClient');
  const claimIndex = executorBody.indexOf('claimTransactionalIdempotency');
  const replayIndex = executorBody.indexOf('if (claim.replayed)');
  const lockIndex = executorBody.indexOf('acquireAtpLocks');
  const executeIndex = executorBody.indexOf('executeTransferInventoryMutation');
  const appendIndex = executorBody.indexOf('appendInventoryEventsWithDispatch');
  const projectionIndex = executorBody.indexOf('for (const projectionOp of execution.projectionOps)');
  const finalizeIndex = executorBody.indexOf('finalizeTransactionalIdempotency');

  for (const [name, index] of Object.entries({
    claimIndex,
    replayIndex,
    lockIndex,
    executeIndex,
    appendIndex,
    projectionIndex,
    finalizeIndex
  })) {
    assert.notEqual(index, -1, `missing ${name} in executeTransferWithClient`);
  }
  assert.ok(claimIndex < replayIndex);
  assert.ok(replayIndex < lockIndex);
  assert.ok(lockIndex < executeIndex);
  assert.ok(executeIndex < appendIndex);
  assert.ok(appendIndex < projectionIndex);
  assert.ok(projectionIndex < finalizeIndex);

  const transferInventoryBody = extractFunctionBody(source, 'transferInventory');
  assert.match(transferInventoryBody, /\bexecuteTransferWithClient\(/);
  for (const forbidden of [
    'claimTransactionalIdempotency',
    'finalizeTransactionalIdempotency',
    'appendInventoryEventsWithDispatch',
    'acquireAtpLocks',
    'executeTransferInventoryMutation'
  ]) {
    assert.equal(transferInventoryBody.includes(forbidden), false, `transferInventory must not duplicate ${forbidden}`);
  }
}

function extractFunctionBody(source, functionName) {
  const marker = source.indexOf(`function ${functionName}`);
  assert.notEqual(marker, -1, `missing function ${functionName}`);
  const paramsOpenIndex = source.indexOf('(', marker);
  assert.notEqual(paramsOpenIndex, -1, `missing parameters for ${functionName}`);
  let paramsDepth = 0;
  let paramsCloseIndex = -1;
  for (let i = paramsOpenIndex; i < source.length; i += 1) {
    if (source[i] === '(') paramsDepth += 1;
    if (source[i] === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        paramsCloseIndex = i;
        break;
      }
    }
  }
  assert.notEqual(paramsCloseIndex, -1, `missing parameter close for ${functionName}`);
  const openBrace = source.indexOf('{', paramsCloseIndex);
  assert.notEqual(openBrace, -1, `missing body for ${functionName}`);
  let depth = 0;
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBrace + 1, i);
      }
    }
  }
  throw new Error(`failed to parse function ${functionName}`);
}
