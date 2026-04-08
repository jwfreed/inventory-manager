import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServiceHarness } from '../helpers/service-harness.mjs';
import { assertMovementContract } from './helpers/mutationContract.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  assessReturnDispositionCostArtifacts,
  repairReturnDispositionCostArtifacts
} = require('../../src/domain/returns/dispositionPosting.ts');
const {
  createReturnAuthorization
} = require('../../src/services/orderToCash.service.ts');
const {
  createReturnReceipt,
  createReturnDisposition,
  getReturnDisposition,
  postReturnDisposition,
  postReturnReceipt
} = require('../../src/services/returnsExtended.service.ts');
const {
  buildMovementDeterministicHash
} = require('../../src/modules/platform/application/inventoryMutationSupport.ts');

async function createPostedReturnReceiptFixture(harness, options = {}) {
  const { topology } = harness;
  const customer = await harness.createCustomer(options.customerPrefix ?? 'RET-DISP');
  const item = await harness.createItem({
    defaultLocationId: topology.defaults.HOLD.id,
    skuPrefix: options.skuPrefix ?? 'RET-DISP',
    type: 'raw'
  });

  const authorization = await createReturnAuthorization(harness.tenantId, {
    rmaNumber: `RMA-${randomUUID().slice(0, 8)}`,
    customerId: customer.id,
    status: 'authorized',
    authorizedAt: '2026-03-11T00:00:00.000Z',
    lines: [{
      itemId: item.id,
      uom: 'each',
      quantityAuthorized: options.quantityAuthorized ?? 2
    }]
  });

  const receipt = await createReturnReceipt(harness.tenantId, {
    returnAuthorizationId: authorization.id,
    receivedAt: '2026-03-12T00:00:00.000Z',
    receivedToLocationId: topology.defaults.HOLD.id,
    lines: [{
      returnAuthorizationLineId: authorization.lines[0].id,
      itemId: item.id,
      uom: 'each',
      quantityReceived: options.quantityReceived ?? 2
    }]
  });

  const postedReceipt = await postReturnReceipt(harness.tenantId, receipt.id, {
    idempotencyKey: `return-receipt-post:${randomUUID()}`
  });

  return {
    topology,
    customer,
    item,
    authorization,
    receipt: postedReceipt
  };
}

test('return disposition creation remains draft-only and posting creates the authoritative transfer movement', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-return-disposition',
    tenantName: 'Return Disposition Contract Tenant'
  });
  const { topology, item, receipt } = await createPostedReturnReceiptFixture(harness);

  const createdDisposition = await createReturnDisposition(harness.tenantId, {
    returnReceiptId: receipt.id,
    status: 'posted',
    occurredAt: '2026-03-13T00:00:00.000Z',
    dispositionType: 'restock',
    fromLocationId: topology.defaults.HOLD.id,
    toLocationId: topology.defaults.SELLABLE.id,
    inventoryMovementId: randomUUID(),
    lines: [{
      lineNumber: 1,
      itemId: item.id,
      uom: 'each',
      quantity: 2
    }]
  });

  assert.equal(createdDisposition.status, 'draft');
  assert.equal(createdDisposition.inventoryMovementId, null);

  const postedDisposition = await postReturnDisposition(harness.tenantId, createdDisposition.id, {
    idempotencyKey: `return-disposition-post:${randomUUID()}`
  });
  assert.equal(postedDisposition.status, 'posted');
  assert.ok(postedDisposition.inventoryMovementId);

  await assertMovementContract({
    harness,
    movementId: postedDisposition.inventoryMovementId,
    expectedMovementType: 'transfer',
    expectedSourceType: 'return_disposition_post',
    expectedLineCount: 2,
    expectedBalances: [
      {
        itemId: item.id,
        locationId: topology.defaults.HOLD.id,
        onHand: 0
      },
      {
        itemId: item.id,
        locationId: topology.defaults.SELLABLE.id,
        onHand: 2
      }
    ]
  });

  const transferConsumptionResult = await harness.pool.query(
    `SELECT COUNT(*)::int AS count
       FROM cost_layer_consumptions
      WHERE tenant_id = $1
        AND movement_id = $2
        AND consumption_type = 'transfer_out'`,
    [harness.tenantId, postedDisposition.inventoryMovementId]
  );
  assert.equal(Number(transferConsumptionResult.rows[0]?.count ?? 0), 1);

  const transferLinkResult = await harness.pool.query(
    `SELECT COUNT(*)::int AS count
       FROM cost_layer_transfer_links
      WHERE tenant_id = $1
        AND transfer_movement_id = $2`,
    [harness.tenantId, postedDisposition.inventoryMovementId]
  );
  assert.equal(Number(transferLinkResult.rows[0]?.count ?? 0), 1);
});

test('return disposition posting replays cleanly and does not duplicate inventory movements', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-return-disposition-replay',
    tenantName: 'Return Disposition Replay Tenant'
  });
  const { topology, item, receipt } = await createPostedReturnReceiptFixture(harness, {
    quantityAuthorized: 1,
    quantityReceived: 1
  });

  const disposition = await createReturnDisposition(harness.tenantId, {
    returnReceiptId: receipt.id,
    occurredAt: '2026-03-14T00:00:00.000Z',
    dispositionType: 'restock',
    fromLocationId: topology.defaults.HOLD.id,
    toLocationId: topology.defaults.SELLABLE.id,
    lines: [{
      lineNumber: 1,
      itemId: item.id,
      uom: 'each',
      quantity: 1
    }]
  });

  const idempotencyKey = `return-disposition-post:${randomUUID()}`;
  const firstPost = await postReturnDisposition(harness.tenantId, disposition.id, { idempotencyKey });
  const replayPost = await postReturnDisposition(harness.tenantId, disposition.id, { idempotencyKey });

  assert.equal(replayPost.id, firstPost.id);
  assert.equal(replayPost.inventoryMovementId, firstPost.inventoryMovementId);

  const movementCount = await harness.pool.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = 'return_disposition_post'
        AND source_id = $2`,
    [harness.tenantId, disposition.id]
  );
  assert.equal(Number(movementCount.rows[0]?.count ?? 0), 1);
});

test('return disposition posting repairs a recoverable partial document state on replay', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-return-disposition-partial',
    tenantName: 'Return Disposition Partial Tenant'
  });
  const { topology, item, receipt } = await createPostedReturnReceiptFixture(harness, {
    quantityAuthorized: 1,
    quantityReceived: 1
  });

  const disposition = await createReturnDisposition(harness.tenantId, {
    returnReceiptId: receipt.id,
    occurredAt: '2026-03-15T00:00:00.000Z',
    dispositionType: 'restock',
    fromLocationId: topology.defaults.HOLD.id,
    toLocationId: topology.defaults.SELLABLE.id,
    lines: [{
      lineNumber: 1,
      itemId: item.id,
      uom: 'each',
      quantity: 1
    }]
  });

  const idempotencyKey = `return-disposition-post:${randomUUID()}`;
  const firstPost = await postReturnDisposition(harness.tenantId, disposition.id, { idempotencyKey });

  await harness.pool.query(
    `UPDATE return_dispositions
        SET status = 'draft',
            inventory_movement_id = NULL
      WHERE tenant_id = $1
        AND id = $2`,
    [harness.tenantId, disposition.id]
  );

  const repairedReplay = await postReturnDisposition(harness.tenantId, disposition.id, { idempotencyKey });
  assert.equal(repairedReplay.inventoryMovementId, firstPost.inventoryMovementId);
  assert.equal(repairedReplay.status, 'posted');

  const repairedRow = await getReturnDisposition(harness.tenantId, disposition.id);
  assert.equal(repairedRow?.inventoryMovementId, firstPost.inventoryMovementId);
  assert.equal(repairedRow?.status, 'posted');
});

test('return disposition posting tolerates drift by converging the document link back to the authoritative movement', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-return-disposition-drift',
    tenantName: 'Return Disposition Drift Tenant'
  });
  const { topology, item, receipt } = await createPostedReturnReceiptFixture(harness, {
    quantityAuthorized: 1,
    quantityReceived: 1
  });

  const disposition = await createReturnDisposition(harness.tenantId, {
    returnReceiptId: receipt.id,
    occurredAt: '2026-03-16T00:00:00.000Z',
    dispositionType: 'restock',
    fromLocationId: topology.defaults.HOLD.id,
    toLocationId: topology.defaults.SELLABLE.id,
    lines: [{
      lineNumber: 1,
      itemId: item.id,
      uom: 'each',
      quantity: 1
    }]
  });

  const idempotencyKey = `return-disposition-post:${randomUUID()}`;
  const firstPost = await postReturnDisposition(harness.tenantId, disposition.id, { idempotencyKey });

  await harness.pool.query(
    `UPDATE return_dispositions
        SET inventory_movement_id = $3
      WHERE tenant_id = $1
        AND id = $2`,
    [harness.tenantId, disposition.id, receipt.inventoryMovementId]
  );

  const repairedReplay = await postReturnDisposition(harness.tenantId, disposition.id, { idempotencyKey });
  assert.equal(repairedReplay.inventoryMovementId, firstPost.inventoryMovementId);

  const repairedRow = await getReturnDisposition(harness.tenantId, disposition.id);
  assert.equal(repairedRow?.inventoryMovementId, firstPost.inventoryMovementId);
});

test('return disposition posting fails closed when the authoritative movement source linkage is corrupted', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-return-disposition-fail',
    tenantName: 'Return Disposition Failure Tenant'
  });
  const { topology, item, receipt } = await createPostedReturnReceiptFixture(harness, {
    quantityAuthorized: 1,
    quantityReceived: 1
  });

  const disposition = await createReturnDisposition(harness.tenantId, {
    returnReceiptId: receipt.id,
    occurredAt: '2026-03-17T00:00:00.000Z',
    dispositionType: 'restock',
    fromLocationId: topology.defaults.HOLD.id,
    toLocationId: topology.defaults.SELLABLE.id,
    lines: [{
      lineNumber: 1,
      itemId: item.id,
      uom: 'each',
      quantity: 1
    }]
  });

  const idempotencyKey = `return-disposition-post:${randomUUID()}`;
  const firstPost = await postReturnDisposition(harness.tenantId, disposition.id, { idempotencyKey });

  const movementLineResult = await harness.pool.query(
    `SELECT item_id,
            location_id,
            quantity_delta,
            canonical_uom,
            unit_cost
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
        AND quantity_delta > 0
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [harness.tenantId, firstPost.inventoryMovementId]
  );
  assert.equal(movementLineResult.rowCount, 1);
  const movementLine = movementLineResult.rows[0];
  const ambiguousMovementId = randomUUID();
  const ambiguousHash = buildMovementDeterministicHash({
    tenantId: harness.tenantId,
    movementType: 'receive',
    occurredAt: '2026-03-19T00:00:00.000Z',
    sourceType: 'return_disposition_post',
    sourceId: disposition.id,
    lines: [{
      itemId: movementLine.item_id,
      locationId: movementLine.location_id,
      quantityDelta: movementLine.quantity_delta,
      canonicalUom: movementLine.canonical_uom,
      unitCost: movementLine.unit_cost,
      reasonCode: 'return_disposition_corruption'
    }]
  });

  await harness.pool.query(
    `INSERT INTO inventory_movements (
        id,
        movement_type,
        status,
        external_ref,
        occurred_at,
        posted_at,
        notes,
        created_at,
        updated_at,
        tenant_id,
        metadata,
        idempotency_key,
        source_type,
        source_id,
        movement_deterministic_hash
      ) VALUES ($1,'receive','posted',$2,$3,$3,$4,$3,$3,$5,NULL,NULL,'return_disposition_post',$6,$7)`,
    [
      ambiguousMovementId,
      `corrupt:${ambiguousMovementId}`,
      '2026-03-19T00:00:00.000Z',
      'Ambiguous authoritative movement',
      harness.tenantId,
      disposition.id,
      ambiguousHash
    ]
  );
  await harness.pool.query(
    `INSERT INTO inventory_movement_lines (
        id,
        movement_id,
        item_id,
        location_id,
        quantity_delta,
        uom,
        reason_code,
        line_notes,
        created_at,
        tenant_id,
        unit_cost,
        extended_cost,
        quantity_delta_entered,
        uom_entered,
        quantity_delta_canonical,
        canonical_uom,
        uom_dimension
      ) VALUES (
        $1,$2,$3,$4,$5,$6,'return_disposition_corruption',$7,$8,$9,$10,$11,$5,$6,$5,$12,'count'
      )`,
    [
      randomUUID(),
      ambiguousMovementId,
      movementLine.item_id,
      movementLine.location_id,
      movementLine.quantity_delta,
      movementLine.canonical_uom,
      'Ambiguous authoritative movement line',
      '2026-03-19T00:00:00.000Z',
      harness.tenantId,
      movementLine.unit_cost,
      Number(movementLine.quantity_delta) * Number(movementLine.unit_cost ?? 0),
      movementLine.canonical_uom
    ]
  );

  await assert.rejects(
    () => postReturnDisposition(harness.tenantId, disposition.id, { idempotencyKey }),
    (error) =>
      error?.code === 'RETURN_DISPOSITION_RECOVERY_IRRECOVERABLE'
      || error?.message === 'RETURN_DISPOSITION_RECOVERY_IRRECOVERABLE'
  );
});

test('return disposition posting prevents duplicate movements even when retried with a new idempotency key', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-return-disposition-duplicate',
    tenantName: 'Return Disposition Duplicate Tenant'
  });
  const { topology, item, receipt } = await createPostedReturnReceiptFixture(harness, {
    quantityAuthorized: 1,
    quantityReceived: 1
  });

  const disposition = await createReturnDisposition(harness.tenantId, {
    returnReceiptId: receipt.id,
    occurredAt: '2026-03-18T00:00:00.000Z',
    dispositionType: 'restock',
    fromLocationId: topology.defaults.HOLD.id,
    toLocationId: topology.defaults.SELLABLE.id,
    lines: [{
      lineNumber: 1,
      itemId: item.id,
      uom: 'each',
      quantity: 1
    }]
  });

  const firstPost = await postReturnDisposition(harness.tenantId, disposition.id, {
    idempotencyKey: `return-disposition-post:${randomUUID()}`
  });
  const secondPost = await postReturnDisposition(harness.tenantId, disposition.id, {
    idempotencyKey: `return-disposition-post:${randomUUID()}`
  });

  assert.equal(secondPost.inventoryMovementId, firstPost.inventoryMovementId);

  const movementCount = await harness.pool.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = 'return_disposition_post'
        AND source_id = $2`,
    [harness.tenantId, disposition.id]
  );
  assert.equal(Number(movementCount.rows[0]?.count ?? 0), 1);
});

test('same-key replay does not resurrect a canceled return disposition', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-return-disposition-canceled',
    tenantName: 'Return Disposition Canceled Replay Tenant'
  });
  const { topology, item, receipt } = await createPostedReturnReceiptFixture(harness, {
    quantityAuthorized: 1,
    quantityReceived: 1
  });

  const disposition = await createReturnDisposition(harness.tenantId, {
    returnReceiptId: receipt.id,
    occurredAt: '2026-03-20T00:00:00.000Z',
    dispositionType: 'restock',
    fromLocationId: topology.defaults.HOLD.id,
    toLocationId: topology.defaults.SELLABLE.id,
    lines: [{
      lineNumber: 1,
      itemId: item.id,
      uom: 'each',
      quantity: 1
    }]
  });
  const idempotencyKey = `return-disposition-post:${randomUUID()}`;
  const firstPost = await postReturnDisposition(harness.tenantId, disposition.id, { idempotencyKey });

  await harness.pool.query(
    `UPDATE return_dispositions
        SET status = 'canceled'
      WHERE tenant_id = $1
        AND id = $2`,
    [harness.tenantId, disposition.id]
  );

  await assert.rejects(
    () => postReturnDisposition(harness.tenantId, disposition.id, { idempotencyKey }),
    (error) => error?.message === 'RETURN_DISPOSITION_CANCELED'
  );

  const persisted = await getReturnDisposition(harness.tenantId, disposition.id);
  assert.equal(persisted?.status, 'canceled');
  assert.equal(persisted?.inventoryMovementId, firstPost.inventoryMovementId);
});

test('return disposition caps count authoritative drifted sibling dispositions', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-return-disposition-drift-cap',
    tenantName: 'Return Disposition Drift Cap Tenant'
  });
  const { topology, item, receipt } = await createPostedReturnReceiptFixture(harness, {
    quantityAuthorized: 3,
    quantityReceived: 3
  });

  const firstDisposition = await createReturnDisposition(harness.tenantId, {
    returnReceiptId: receipt.id,
    occurredAt: '2026-03-21T00:00:00.000Z',
    dispositionType: 'restock',
    fromLocationId: topology.defaults.HOLD.id,
    toLocationId: topology.defaults.SELLABLE.id,
    lines: [{
      lineNumber: 1,
      itemId: item.id,
      uom: 'each',
      quantity: 1
    }]
  });
  const postedFirst = await postReturnDisposition(harness.tenantId, firstDisposition.id, {
    idempotencyKey: `return-disposition-post:${randomUUID()}`
  });

  await harness.pool.query(
    `UPDATE return_dispositions
        SET status = 'draft',
            inventory_movement_id = NULL
      WHERE tenant_id = $1
        AND id = $2`,
    [harness.tenantId, firstDisposition.id]
  );

  const secondDisposition = await createReturnDisposition(harness.tenantId, {
    returnReceiptId: receipt.id,
    occurredAt: '2026-03-22T00:00:00.000Z',
    dispositionType: 'restock',
    fromLocationId: topology.defaults.HOLD.id,
    toLocationId: topology.defaults.SELLABLE.id,
    lines: [{
      lineNumber: 1,
      itemId: item.id,
      uom: 'each',
      quantity: 3
    }]
  });

  await assert.rejects(
    () => postReturnDisposition(harness.tenantId, secondDisposition.id, {
      idempotencyKey: `return-disposition-post:${randomUUID()}`
    }),
    (error) => error?.message === 'RETURN_DISPOSITION_QTY_EXCEEDS_RECEIVED'
  );
  assert.ok(postedFirst.inventoryMovementId);
});

test('disposition cost recovery repairs missing transfer cost artifacts before commit', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'contract-return-disposition-repair',
    tenantName: 'Return Disposition Replay Repair Tenant'
  });
  const { topology, item, receipt } = await createPostedReturnReceiptFixture(harness, {
    quantityAuthorized: 1,
    quantityReceived: 1
  });

  const disposition = await createReturnDisposition(harness.tenantId, {
    returnReceiptId: receipt.id,
    occurredAt: '2026-03-23T00:00:00.000Z',
    dispositionType: 'restock',
    fromLocationId: topology.defaults.HOLD.id,
    toLocationId: topology.defaults.SELLABLE.id,
    lines: [{
      lineNumber: 1,
      itemId: item.id,
      uom: 'each',
      quantity: 1
    }]
  });
  const movementId = randomUUID();
  const movementHash = buildMovementDeterministicHash({
    tenantId: harness.tenantId,
    movementType: 'transfer',
    occurredAt: '2026-03-23T00:00:00.000Z',
    sourceType: 'return_disposition_post',
    sourceId: disposition.id,
    lines: [
      {
        itemId: item.id,
        locationId: topology.defaults.HOLD.id,
        quantityDelta: -1,
        canonicalUom: 'each',
        unitCost: 0,
        reasonCode: 'return_restock_out'
      },
      {
        itemId: item.id,
        locationId: topology.defaults.SELLABLE.id,
        quantityDelta: 1,
        canonicalUom: 'each',
        unitCost: 0,
        reasonCode: 'return_restock_in'
      }
    ]
  });
  const outLineId = randomUUID();
  const inLineId = randomUUID();

  const client = await harness.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO inventory_movements (
          id,
          movement_type,
          status,
          external_ref,
          occurred_at,
          posted_at,
          notes,
          created_at,
          updated_at,
          tenant_id,
          metadata,
          idempotency_key,
          source_type,
          source_id,
          movement_deterministic_hash
        ) VALUES ($1,'transfer','posted',$2,$3,$3,$4,$3,$3,$5,NULL,NULL,'return_disposition_post',$6,$7)`,
      [
        movementId,
        `return_disposition:${disposition.id}`,
        '2026-03-23T00:00:00.000Z',
        'Synthetic source-backed disposition movement',
        harness.tenantId,
        disposition.id,
        movementHash
      ]
    );
    await client.query(
      `INSERT INTO inventory_movement_lines (
          id,
          movement_id,
          item_id,
          location_id,
          quantity_delta,
          uom,
          reason_code,
          line_notes,
          created_at,
          tenant_id,
          unit_cost,
          extended_cost,
          quantity_delta_entered,
          uom_entered,
          quantity_delta_canonical,
          canonical_uom,
          uom_dimension
        ) VALUES
          ($1,$2,$3,$4,$5,$6,'return_restock_out',$7,$8,$9,$10,$11,$12,$13,$14,$15,'count'),
          ($16,$2,$3,$17,$18,$6,'return_restock_in',$19,$8,$9,$20,$21,$22,$13,$23,$15,'count')`,
      [
        outLineId,
        movementId,
        item.id,
        topology.defaults.HOLD.id,
        -1,
        'each',
        'Synthetic return disposition outbound line',
        '2026-03-23T00:00:00.000Z',
        harness.tenantId,
        0,
        0,
        -1,
        'each',
        -1,
        'each',
        inLineId,
        topology.defaults.SELLABLE.id,
        1,
        'Synthetic return disposition inbound line',
        0,
        0,
        1,
        1
      ]
    );

    const assessment = await assessReturnDispositionCostArtifacts({
      client,
      tenantId: harness.tenantId,
      dispositionId: disposition.id,
      movementId
    });
    assert.equal(assessment.ready, false);
    assert.equal(assessment.repairable, true);

    await repairReturnDispositionCostArtifacts({
      client,
      tenantId: harness.tenantId,
      dispositionId: disposition.id,
      movementId
    });

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const repairedArtifacts = await harness.pool.query(
    `SELECT
        (SELECT COUNT(*)::int
           FROM cost_layer_transfer_links
          WHERE tenant_id = $1
            AND transfer_movement_id = $2) AS link_count,
        (SELECT COUNT(*)::int
           FROM cost_layer_consumptions
          WHERE tenant_id = $1
            AND movement_id = $2
            AND consumption_type = 'transfer_out') AS consumption_count,
        (SELECT COUNT(*)::int
           FROM inventory_cost_layers
          WHERE tenant_id = $1
            AND movement_id = $2
            AND source_type = 'transfer_in'
            AND voided_at IS NULL) AS transfer_in_layer_count`,
    [harness.tenantId, movementId]
  );
  assert.equal(Number(repairedArtifacts.rows[0]?.link_count ?? 0), 1);
  assert.equal(Number(repairedArtifacts.rows[0]?.consumption_count ?? 0), 1);
  assert.equal(Number(repairedArtifacts.rows[0]?.transfer_in_layer_count ?? 0), 1);
});
