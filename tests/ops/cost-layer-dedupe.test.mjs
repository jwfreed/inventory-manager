import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { ensureStandardWarehouse } from '../api/helpers/warehouse-bootstrap.mjs';
import { waitForCondition } from '../api/helpers/waitFor.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = process.env.SEED_TENANT_SLUG || 'default';
let db;

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

async function getSession() {
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug: tenantSlug,
    tenantName: 'Cost Layer Dedupe Tenant'
  });
  db = session.pool;
  return session;
}

test('cost layer dedupe keeps one active receipt layer per source', async () => {
  const session = await getSession();
  const token = session.accessToken;
  const tenantId = session.tenant?.id;
  assert.ok(token);
  assert.ok(tenantId);

  const { defaults } = await ensureStandardWarehouse({ token, apiRequest, scope: import.meta.url});
  const locationId = defaults.SELLABLE.id;

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

  await db.query('DROP INDEX IF EXISTS uq_cost_layers_receipt_source_active');

  const insertLayer = async (createdAt) => {
    await db.query(
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

  await db.query(
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

  await waitForCondition(
    async () => {
      const countRes = await db.query(
        `SELECT COUNT(*)::int AS count
           FROM inventory_cost_layers
          WHERE tenant_id = $1
            AND source_type = 'receipt'
            AND source_document_id = $2
            AND voided_at IS NULL`,
        [tenantId, sourceId]
      );
      return countRes.rows[0].count;
    },
    (count) => count === 1,
    { label: 'dedupe active receipt layers before index' }
  );

  await db.query(
    `CREATE UNIQUE INDEX uq_cost_layers_receipt_source_active
       ON inventory_cost_layers (tenant_id, source_document_id)
      WHERE source_type = 'receipt' AND source_document_id IS NOT NULL AND voided_at IS NULL`
  );

  const finalCount = await waitForCondition(
    async () => {
      const countRes = await db.query(
        `SELECT COUNT(*)::int AS count
           FROM inventory_cost_layers
          WHERE tenant_id = $1
            AND source_type = 'receipt'
            AND source_document_id = $2
            AND voided_at IS NULL`,
        [tenantId, sourceId]
      );
      return countRes.rows[0].count;
    },
    (count) => count === 1,
    { label: 'dedupe active receipt layers after index' }
  );
  assert.equal(finalCount, 1);
});
