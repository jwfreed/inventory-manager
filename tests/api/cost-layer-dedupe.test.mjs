import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `cost-layer-dedupe-${Date.now()}`;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { res, payload };
}

async function ensureSession() {
  const bootstrap = await apiRequest('POST', '/auth/bootstrap', {
    body: {
      adminEmail,
      adminPassword,
      tenantSlug,
      tenantName: 'Cost Layer Dedupe Tenant',
    },
  });
  if (bootstrap.res.ok) return bootstrap.payload;
  if (bootstrap.res.status !== 409) {
    throw new Error(`Bootstrap failed: ${bootstrap.res.status}`);
  }
  let login = await apiRequest('POST', '/auth/login', {
    body: { email: adminEmail, password: adminPassword, tenantSlug },
  });
  if (login.res.status === 400) {
    const userRes = await pool.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [adminEmail]);
    const userId = userRes.rows[0]?.id;
    if (!userId) {
      throw new Error('Login failed: user not found');
    }
    const tenantRes = await pool.query('SELECT id FROM tenants WHERE slug = $1', [tenantSlug]);
    let tenantId = tenantRes.rows[0]?.id;
    if (!tenantId) {
      tenantId = uuidv4();
      await pool.query(
        `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
         VALUES ($1, $2, $3, NULL, now())`,
        [tenantId, 'Cost Layer Dedupe Tenant', tenantSlug]
      );
    }
    await pool.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status, created_at)
       VALUES ($1, $2, $3, 'admin', 'active', now())
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [uuidv4(), tenantId, userId]
    );
    login = await apiRequest('POST', '/auth/login', {
      body: { email: adminEmail, password: adminPassword, tenantSlug },
    });
  }
  if (login.res.status !== 200) {
    throw new Error(`Login failed: ${login.res.status}`);
  }
  return login.payload;
}

test('cost layer dedupe keeps one active receipt layer per source', async (t) => {
  t.after(async () => {
    await pool.end();
  });

  const session = await ensureSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const locationRes = await apiRequest('POST', '/locations', {
    token,
    body: {
      code: `DEDUP-LOC-${Date.now()}`,
      name: 'Dedupe Location',
      type: 'warehouse',
      active: true
    }
  });
  assert.equal(locationRes.res.status, 201);
  const locationId = locationRes.payload.id;

  const itemRes = await apiRequest('POST', '/items', {
    token,
    body: {
      sku: `DEDUP-ITEM-${Date.now()}`,
      name: 'Dedupe Item',
      uomDimension: 'count',
      canonicalUom: 'each',
      stockingUom: 'each',
      defaultLocationId: locationId
    }
  });
  assert.equal(itemRes.res.status, 201);
  const itemId = itemRes.payload.id;
  const sourceId = uuidv4();

  await pool.query('DROP INDEX IF EXISTS uq_cost_layers_receipt_source_active');

  const insertLayer = async (createdAt) => {
    await pool.query(
      `INSERT INTO inventory_cost_layers (
          id, tenant_id, item_id, location_id, uom, layer_date, layer_sequence,
          original_quantity, remaining_quantity, unit_cost, extended_cost,
          source_type, source_document_id, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
      [
        uuidv4(),
        tenantId,
        itemId,
        locationId,
        'each',
        createdAt,
        1,
        10,
        10,
        5,
        50,
        'receipt',
        sourceId,
        createdAt
      ]
    );
  };

  const earlier = new Date(Date.now() - 10000);
  const later = new Date();
  await insertLayer(earlier);
  await insertLayer(later);

  await pool.query(
    `WITH ranked AS (
       SELECT id,
              tenant_id,
              source_document_id,
              created_at,
              ROW_NUMBER() OVER (
                PARTITION BY tenant_id, source_document_id
                ORDER BY created_at ASC, id ASC
              ) AS rn,
              FIRST_VALUE(id) OVER (
                PARTITION BY tenant_id, source_document_id
                ORDER BY created_at ASC, id ASC
              ) AS keep_id
         FROM inventory_cost_layers
        WHERE source_type = 'receipt'
          AND source_document_id IS NOT NULL
          AND voided_at IS NULL
     )
     UPDATE inventory_cost_layers c
        SET voided_at = now(),
            void_reason = 'superseded duplicate',
            superseded_by_id = r.keep_id
       FROM ranked r
      WHERE c.id = r.id
        AND r.rn > 1`
  );

  await pool.query(
    `CREATE UNIQUE INDEX uq_cost_layers_receipt_source_active
       ON inventory_cost_layers (tenant_id, source_document_id)
      WHERE source_type = 'receipt' AND source_document_id IS NOT NULL AND voided_at IS NULL`
  );

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND source_type = 'receipt'
        AND source_document_id = $2
        AND voided_at IS NULL`,
    [tenantId, sourceId]
  );
  assert.equal(countRes.rows[0].count, 1);
});
