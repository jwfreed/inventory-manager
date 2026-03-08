import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';

async function apiRequest(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await res.json().catch(() => null)
    : await res.text().catch(() => '');
  return { res, payload };
}

async function createVendor(token) {
  const code = `LPN-V-${randomUUID().slice(0, 8)}`;
  const res = await apiRequest('POST', '/vendors', {
    token,
    body: { code, name: `Vendor ${code}` }
  });
  assert.equal(res.res.status, 201, JSON.stringify(res.payload));
  return res.payload.id;
}

async function createItem(token, defaultLocationId) {
  const sku = `LPN-ITEM-${randomUUID().slice(0, 8)}`;
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

async function seedPostedStock({ db, tenantId, itemId, locationId, quantity, unitCost, uom = 'each' }) {
  const movementId = randomUUID();
  const movementLineId = randomUUID();
  const layerId = randomUUID();
  const sourceDocumentId = randomUUID();
  const createdAt = '2026-01-01T00:00:00.000Z';

  await db.query(
    `INSERT INTO inventory_movements (
        id,
        tenant_id,
        movement_type,
        status,
        external_ref,
        source_type,
        source_id,
        occurred_at,
        posted_at,
        notes,
        created_at,
        updated_at
      ) VALUES (
        $1,
        $2,
        'receive',
        'posted',
        $3,
        'test_seed',
        $4,
        $5,
        $5,
        'seed',
        $5,
        $5
      )`,
    [movementId, tenantId, `seed:${movementId}`, sourceDocumentId, createdAt]
  );
  await db.query(
    `INSERT INTO inventory_movement_lines (
        id,
        tenant_id,
        movement_id,
        item_id,
        location_id,
        quantity_delta,
        uom,
        quantity_delta_entered,
        uom_entered,
        quantity_delta_canonical,
        canonical_uom,
        uom_dimension,
        unit_cost,
        extended_cost,
        reason_code,
        line_notes,
        created_at
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $6,
        $7,
        $6,
        $7,
        'count',
        $8,
        $9,
        'seed_receive',
        'seed',
        $10
      )`,
    [movementLineId, tenantId, movementId, itemId, locationId, quantity, uom, unitCost, quantity * unitCost, createdAt]
  );
  await db.query(
    `INSERT INTO inventory_balance (
        tenant_id, item_id, location_id, uom, on_hand, reserved, allocated, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $6)
      ON CONFLICT (tenant_id, item_id, location_id, uom)
      DO UPDATE SET on_hand = EXCLUDED.on_hand,
                    reserved = EXCLUDED.reserved,
                    allocated = EXCLUDED.allocated,
                    updated_at = EXCLUDED.updated_at`,
    [tenantId, itemId, locationId, uom, quantity, createdAt]
  );
  await db.query(
    `INSERT INTO inventory_cost_layers (
        id,
        tenant_id,
        item_id,
        location_id,
        uom,
        layer_date,
        layer_sequence,
        original_quantity,
        remaining_quantity,
        unit_cost,
        extended_cost,
        source_type,
        source_document_id,
        movement_id,
        notes,
        created_at,
        updated_at
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        1,
        $7,
        $7,
        $8,
        $9,
        'adjustment',
        $10,
        $11,
        'seed',
        $6,
        $6
      )`,
    [layerId, tenantId, itemId, locationId, uom, createdAt, quantity, unitCost, quantity * unitCost, sourceDocumentId, movementId]
  );
}

test('license plate move replay detects movement-link corruption', async () => {
  const tenantSlug = `lpn-integrity-${randomUUID().slice(0, 8)}`;
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'License Plate Integrity Tenant'
  });
  const token = session.accessToken;
  const db = session.pool;
  const tenantId = session.tenant.id;

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url });
  const itemId = await createItem(token, defaults.SELLABLE.id);
  await seedPostedStock({
    db,
    tenantId,
    itemId,
    locationId: defaults.SELLABLE.id,
    quantity: 5,
    unitCost: 3
  });

  const createLpnRes = await apiRequest('POST', '/lpns', {
    token,
    body: {
      lpn: `LPN-${randomUUID().slice(0, 8)}`,
      itemId,
      locationId: defaults.SELLABLE.id,
      quantity: 5,
      uom: 'each'
    }
  });
  assert.equal(createLpnRes.res.status, 201, JSON.stringify(createLpnRes.payload));
  const licensePlateId = createLpnRes.payload.data.id;

  const idempotencyKey = `lpn-move-${randomUUID()}`;
  const moveRes = await apiRequest('POST', `/lpns/${licensePlateId}/move`, {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      fromLocationId: defaults.SELLABLE.id,
      toLocationId: defaults.QA.id,
      notes: 'Integrity replay move'
    }
  });
  assert.equal(moveRes.res.status, 200, JSON.stringify(moveRes.payload));

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
        quantity_delta
      ) VALUES ($1, $2, $3, $4, 1)`,
    [randomUUID(), tenantId, lineRes.rows[0].id, licensePlateId]
  );

  const replay = await apiRequest('POST', `/lpns/${licensePlateId}/move`, {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      fromLocationId: defaults.SELLABLE.id,
      toLocationId: defaults.QA.id,
      notes: 'Integrity replay move'
    }
  });
  assert.equal(replay.res.status, 409, JSON.stringify(replay.payload));
  assert.equal(replay.payload?.error?.code, 'LICENSE_PLATE_INTEGRITY_FAILED');
});
