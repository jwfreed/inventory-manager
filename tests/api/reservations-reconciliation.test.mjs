import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || `ci-admin+${randomUUID().slice(0,8)}@example.com`;
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = process.env.SEED_TENANT_SLUG || `default-${randomUUID().slice(0,8)}`;
const TOLERANCE = 1e-6;

function createPool() {
  return new Pool({ connectionString: process.env.DATABASE_URL });
}

const sharedPool = createPool();

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

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function assertOk(res, label, payload, requestBody, allowed = [200, 201]) {
  if (!allowed.includes(res.status)) {
    const body = typeof payload === 'string' ? payload : safeJson(payload);
    const req = requestBody ? safeJson(requestBody) : '';
    throw new Error(`BOOTSTRAP_FAILED ${label} status=${res.status} body=${body}${req ? ` request=${req}` : ''}`);
  }
}

function isDescendant(location, warehouseId, byId) {
  let current = location;
  const visited = new Set();
  let depth = 0;
  while (current && current.parentLocationId) {
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    if (current.parentLocationId === warehouseId) return true;
    current = byId.get(current.parentLocationId);
    depth += 1;
    if (depth > 20) return false;
  }
  return false;
}

function formatLocation(location) {
  if (!location) return null;
  return {
    id: location.id,
    code: location.code,
    name: location.name,
    type: location.type,
    role: location.role,
    parentLocationId: location.parentLocationId
  };
}

async function ensureSession() {
  const bootstrapBody = {
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Reservation Reconciliation Tenant',
  };
  const bootstrap = await apiRequest('POST', '/auth/bootstrap', { body: bootstrapBody });
  if (bootstrap.res.ok) return bootstrap.payload;
  assertOk(bootstrap.res, 'POST /auth/bootstrap', bootstrap.payload, bootstrapBody, [200, 201, 409]);

  const loginBody = { email: adminEmail, password: adminPassword, tenantSlug };
  const login = await apiRequest('POST', '/auth/login', { body: loginBody });
  assertOk(login.res, 'POST /auth/login', login.payload, loginBody, [200]);
  return login.payload;
}

async function ensureWarehouse(token, tenantId, pool = sharedPool) {
  if (!tenantId) {
    const meRes = await apiRequest('GET', '/auth/me', { token });
    assert.equal(meRes.res.status, 200);
    tenantId = meRes.payload?.tenantId || meRes.payload?.tenant?.id || meRes.payload?.user?.tenantId;
  }
  assert.ok(tenantId);
  const locationsRes = await apiRequest('GET', '/locations', { token, params: { limit: 200 } });
  assert.equal(locationsRes.res.status, 200);
  let locations = locationsRes.payload.data || [];
  let warehouse = locations.find((loc) => loc.type === 'warehouse');
  if (!warehouse) {
    const code = `WH-${randomUUID()}`;
    const body = {
        code,
        name: `Warehouse ${code}`,
        type: 'warehouse',
        role: 'SELLABLE',
        isSellable: true,
        active: true
    };
    const createRes = await apiRequest('POST', '/locations', { token, body });
    assertOk(createRes.res, 'POST /locations (warehouse)', createRes.payload, body, [201]);
    warehouse = createRes.payload;
    locations = [...locations, warehouse];
  }
  const ensureRole = async (role) => {
    let loc = locations.find(
      (entry) => entry.role === role && entry.parentLocationId === warehouse.id
    );
    if (!loc) {
      const code = `${role}-${randomUUID().slice(0, 8)}`;
      const body = {
          code,
          name: `${role} Location`,
          type: role === 'SCRAP' ? 'scrap' : 'bin',
          role,
          isSellable: role === 'SELLABLE',
          parentLocationId: warehouse.id
      };
      const createRes = await apiRequest('POST', '/locations', { token, body });
      assertOk(createRes.res, `POST /locations (${role})`, createRes.payload, body, [201]);
      loc = createRes.payload;
      locations = [...locations, loc];
    }
    await pool.query(
      `INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [tenantId, warehouse.id, role, loc.id]
    );
    return loc;
  };
  await ensureRole('SELLABLE');
  await ensureRole('QA');
  await ensureRole('HOLD');
  await ensureRole('REJECT');
  const defaultsRes = await pool.query(
    `SELECT location_id
       FROM warehouse_default_location
      WHERE tenant_id = $1 AND warehouse_id = $2 AND role = 'SELLABLE'`,
    [tenantId, warehouse.id]
  );
  const defaultSellableId = defaultsRes.rows[0]?.location_id;
  const sellable =
    locations.find((loc) => loc.id === defaultSellableId) ||
    locations.find((loc) => loc.role === 'SELLABLE' && loc.parentLocationId === warehouse.id) ||
    locations.find((loc) => loc.role === 'SELLABLE');
  assert.ok(sellable);
  const byId = new Map(locations.map((loc) => [loc.id, loc]));
  const diagnostics = {
    warehouseId: warehouse.id,
    warehouse: formatLocation(warehouse),
    sellable: formatLocation(sellable),
    locations: locations.map(formatLocation),
    defaults: defaultsRes.rows
  };
  if (warehouse.parentLocationId !== null || warehouse.type !== 'warehouse') {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID root\n${safeJson(diagnostics)}`);
  }
  if (!sellable.parentLocationId || !isDescendant(sellable, warehouse.id, byId)) {
    throw new Error(`WAREHOUSE_BOOTSTRAP_INVALID sellable\n${safeJson(diagnostics)}`);
  }
  return { sellable };
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

async function expireReservationsDirect(pool, tenantId) {
  const client = await pool.connect();
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

test('Reservation balance reconciliation matches reservations remaining qty', async (t) => {
  const pool = createPool();
  t.after(async () => {
    await pool.end();
  });

  const session = await ensureSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { sellable } = await ensureWarehouse(token, session.tenant.id, pool);
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

  await expireReservationsDirect(pool, tenantId);

  const recon = await pool.query(
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
