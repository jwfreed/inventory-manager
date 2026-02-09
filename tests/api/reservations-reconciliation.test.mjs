import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSession } from './helpers/ensureSession.mjs';
import { ensureStandardWarehouse } from './helpers/warehouse-bootstrap.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = process.env.SEED_TENANT_SLUG || 'default';
let db;
const TOLERANCE = 1e-6;

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
  const session = await ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: 'Reservation Reconciliation Tenant'
  });
  db = session.pool;
  return session;
}

async function seedItemAndStock(token, sellableLocationId, quantity = 10) {
  const sku = `RECON-${randomUUID()}`;
  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku,
      name: `Item ${sku}`,
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: sellableLocationId,
    },
  });
  assert.equal(itemRes.res.status, 201);
  const itemId = itemRes.payload.id;

  const adjustmentRes = await apiRequest('POST', '/inventory-adjustments', {
    token,
    body: {
      occurredAt: new Date().toISOString(),
      reasonCode: 'seed',
      lines: [
        {
          lineNumber: 1,
          itemId,
          locationId: sellableLocationId,
          uom: 'each',
          quantityDelta: quantity,
          reasonCode: 'seed',
        },
      ],
    },
  });
  assert.equal(adjustmentRes.res.status, 201);
  const postRes = await apiRequest('POST', `/inventory-adjustments/${adjustmentRes.payload.id}/post`, { token });
  assert.equal(postRes.res.status, 200);
  return itemId;
}

async function expireReservationsDirect(db, tenantId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `SELECT id, tenant_id, item_id, location_id, uom, quantity_reserved, quantity_fulfilled
         FROM inventory_reservations
        WHERE tenant_id = $1
          AND status = 'RESERVED'
          AND expires_at IS NOT NULL
          AND expires_at <= now()
        FOR UPDATE`,
      [tenantId]
    );
    for (const row of res.rows) {
      const remaining = Math.max(0, Number(row.quantity_reserved) - Number(row.quantity_fulfilled ?? 0));
      if (remaining > 0) {
        await client.query(
          `UPDATE inventory_balance
              SET reserved = GREATEST(0, reserved - $1),
                  updated_at = now()
            WHERE tenant_id = $2 AND item_id = $3 AND location_id = $4 AND uom = $5`,
          [remaining, row.tenant_id, row.item_id, row.location_id, row.uom]
        );
      }
      await client.query(
        `UPDATE inventory_reservations
            SET status = 'EXPIRED',
                expired_at = now(),
                updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [row.id, row.tenant_id]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('Reservation balance reconciliation matches reservations remaining qty', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});
  const sellable = defaults.SELLABLE;
  const itemId = await seedItemAndStock(token, sellable.id, 12);

  const reserveRes = await apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `reserve-${randomUUID()}` },
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId,
          locationId: sellable.id,
          uom: 'each',
          quantityReserved: 6,
          allowBackorder: false,
        },
      ],
    },
  });
  assert.equal(reserveRes.res.status, 201);
  const reservationId = reserveRes.payload.data[0].id;

  const allocateRes = await apiRequest('POST', `/reservations/${reservationId}/allocate`, {
    token,
    headers: { 'Idempotency-Key': `alloc-${randomUUID()}` },
  });
  assert.equal(allocateRes.res.status, 200);

  const fulfillRes = await apiRequest('POST', `/reservations/${reservationId}/fulfill`, {
    token,
    headers: { 'Idempotency-Key': `fulfill-${randomUUID()}` },
    body: { quantity: 6 },
  });
  assert.equal(fulfillRes.res.status, 200);

  const expReserve = await apiRequest('POST', '/reservations', {
    token,
    headers: { 'Idempotency-Key': `reserve-exp-${randomUUID()}` },
    body: {
      reservations: [
        {
          demandType: 'sales_order_line',
          demandId: randomUUID(),
          itemId,
          locationId: sellable.id,
          uom: 'each',
          quantityReserved: 2,
          allowBackorder: false,
          expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
        },
      ],
    },
  });
  assert.equal(expReserve.res.status, 201);

  await expireReservationsDirect(db, tenantId);

  const recon = await db.query(
    `WITH reservation_committed AS (
       SELECT tenant_id,
              item_id,
              location_id,
              uom,
              SUM(
                CASE
                  WHEN status = 'RESERVED'
                  THEN GREATEST(0, quantity_reserved - COALESCE(quantity_fulfilled, 0))
                  ELSE 0
                END
              ) AS reserved,
              SUM(
                CASE
                  WHEN status = 'ALLOCATED'
                  THEN GREATEST(0, quantity_reserved - COALESCE(quantity_fulfilled, 0))
                  ELSE 0
                END
              ) AS allocated
         FROM inventory_reservations
        WHERE tenant_id = $1
          AND status IN ('RESERVED','ALLOCATED')
        GROUP BY tenant_id, item_id, location_id, uom
     ),
     combined AS (
       SELECT b.tenant_id,
              b.item_id,
              b.location_id,
              b.uom,
              (b.reserved + b.allocated) AS balance_committed,
              COALESCE(r.reserved, 0) + COALESCE(r.allocated, 0) AS reservation_committed
         FROM inventory_balance b
         LEFT JOIN reservation_committed r
           ON r.tenant_id = b.tenant_id
          AND r.item_id = b.item_id
          AND r.location_id = b.location_id
          AND r.uom = b.uom
        WHERE b.tenant_id = $1
     )
     SELECT *
       FROM combined
      WHERE ABS(balance_committed - reservation_committed) > $2`,
    [tenantId, TOLERANCE]
  );

  assert.equal(recon.rowCount, 0);
});
