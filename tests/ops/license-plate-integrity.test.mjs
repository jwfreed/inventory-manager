import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from './helpers/service-harness.mjs';

test('license plate move replay detects movement-link corruption without HTTP', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'lpn-integrity',
    tenantName: 'License Plate Integrity Tenant'
  });
  const { pool: db, tenantId, topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'LPN-ITEM',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 3
  });

  const licensePlate = await harness.createLicensePlate({
    lpn: `LPN-${randomUUID().slice(0, 8)}`,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    uom: 'each'
  });
  assert.ok(licensePlate?.id);

  const idempotencyKey = `lpn-move-${randomUUID()}`;
  const move = await harness.moveLicensePlate({
    licensePlateId: licensePlate.id,
    fromLocationId: topology.defaults.SELLABLE.id,
    toLocationId: topology.defaults.QA.id,
    notes: 'Integrity replay move',
    idempotencyKey
  });
  assert.equal(move.locationId, topology.defaults.QA.id);

  const movementRes = await db.query(
    `SELECT id
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = 'lpn_move'
        AND idempotency_key = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [tenantId, idempotencyKey]
  );
  assert.equal(movementRes.rowCount, 1);
  const movementId = movementRes.rows[0].id;

  const lineRes = await db.query(
    `SELECT id
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [tenantId, movementId]
  );
  assert.equal(lineRes.rowCount, 1);

  await db.query(
    `INSERT INTO inventory_movement_lpns (
        id,
        tenant_id,
        inventory_movement_line_id,
        license_plate_id,
        quantity_delta,
        uom
      ) VALUES ($1, $2, $3, $4, 1, 'each')`,
    [randomUUID(), tenantId, lineRes.rows[0].id, licensePlate.id]
  );

  await assert.rejects(
    harness.moveLicensePlate({
      licensePlateId: licensePlate.id,
      fromLocationId: topology.defaults.SELLABLE.id,
      toLocationId: topology.defaults.QA.id,
      notes: 'Integrity replay move',
      idempotencyKey
    }),
    (error) => {
      assert.equal(error?.code ?? error?.message, 'LICENSE_PLATE_INTEGRITY_FAILED');
      return true;
    }
  );
});

test('license plate move replay fails closed when the plate projection drifts from the authoritative movement', async () => {
  const harness = await createServiceHarness({
    tenantPrefix: 'lpn-projection-drift',
    tenantName: 'License Plate Projection Drift Tenant'
  });
  const { pool: db, tenantId, topology } = harness;

  const item = await harness.createItem({
    defaultLocationId: topology.defaults.SELLABLE.id,
    skuPrefix: 'LPN-DRIFT',
    type: 'raw'
  });
  await harness.seedStockViaCount({
    warehouseId: topology.warehouse.id,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 3
  });

  const licensePlate = await harness.createLicensePlate({
    lpn: `LPN-${randomUUID().slice(0, 8)}`,
    itemId: item.id,
    locationId: topology.defaults.SELLABLE.id,
    quantity: 5,
    uom: 'each'
  });
  const idempotencyKey = `lpn-drift-${randomUUID()}`;

  await harness.moveLicensePlate({
    licensePlateId: licensePlate.id,
    fromLocationId: topology.defaults.SELLABLE.id,
    toLocationId: topology.defaults.QA.id,
    notes: 'Projection drift move',
    idempotencyKey
  });

  await db.query(
    `UPDATE license_plates
        SET location_id = $3,
            updated_at = now()
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, licensePlate.id, topology.defaults.SELLABLE.id]
  );

  await assert.rejects(
    harness.moveLicensePlate({
      licensePlateId: licensePlate.id,
      fromLocationId: topology.defaults.SELLABLE.id,
      toLocationId: topology.defaults.QA.id,
      notes: 'Projection drift move',
      idempotencyKey
    }),
    (error) => {
      assert.equal(error?.code ?? error?.message, 'LICENSE_PLATE_INTEGRITY_FAILED');
      assert.equal(error?.details?.reason, 'license_plate_state_mismatch');
      return true;
    }
  );
});
