/**
 * Regression guard: migration 1794000000000_align_import_job_rows_serial_identity
 * preflight block must detect ambiguous normalized SKUs within the same tenant
 * and raise ITEMS_AMBIGUOUS_NORMALIZED_SKU before any schema changes are made.
 *
 * The test exercises the exact DO $$ ... $$ SQL from the migration in isolation,
 * using a throw-away tenant.  If the preflight is removed, the UPDATE backfill
 * would produce non-deterministic item_id assignments without any error.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

test.after(async () => {
  await pool.end();
});

// The exact preflight fragment from migration 1794000000000 that detects
// tenants with more than one item sharing the same lower(btrim(sku)).
const AMBIGUOUS_SKU_PREFLIGHT = `
  DO $$
  DECLARE
    ambiguous_rec record;
  BEGIN
    SELECT tenant_id, lower(btrim(sku)) AS normalized_sku, COUNT(*) AS cnt
      INTO ambiguous_rec
      FROM items
     GROUP BY tenant_id, lower(btrim(sku))
    HAVING COUNT(*) > 1
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'ITEMS_AMBIGUOUS_NORMALIZED_SKU tenant_id=%, sku=%, count=%',
        ambiguous_rec.tenant_id,
        ambiguous_rec.normalized_sku,
        ambiguous_rec.cnt
        USING ERRCODE = '23505';
    END IF;
  END $$;
`;

test('migration preflight fails with ITEMS_AMBIGUOUS_NORMALIZED_SKU when two items share normalized SKU in same tenant', async () => {
  const tenantId = randomUUID();
  const itemId1 = randomUUID();
  const itemId2 = randomUUID();

  // SKUs differ only by case — distinct as stored strings, identical after lower(btrim()).
  const sku1 = `AMBIG-PREFLIGHT-${randomUUID().slice(0, 8).toUpperCase()}`;
  const sku2 = sku1.toLowerCase();

  await pool.query(
    `INSERT INTO tenants (id, name, slug, created_at)
     VALUES ($1, $2, $3, now())`,
    [tenantId, 'Preflight Ambiguous SKU Test Tenant', `preflight-ambig-${tenantId.slice(0, 8)}`]
  );
  try {
    await pool.query(
      `INSERT INTO items (id, tenant_id, sku, name, updated_at)
       VALUES ($1, $2, $3, $4, now()),
              ($5, $2, $6, $7, now())`,
      [itemId1, tenantId, sku1, 'Item One', itemId2, sku2, 'Item Two']
    );

    // The preflight must raise; if it doesn't, the migration protection is absent.
    await assert.rejects(
      () => pool.query(AMBIGUOUS_SKU_PREFLIGHT),
      (err) => {
        // PostgreSQL wraps DO $$ exceptions in an error whose message contains
        // the text passed to RAISE EXCEPTION.
        assert.ok(
          String(err.message).includes('ITEMS_AMBIGUOUS_NORMALIZED_SKU'),
          `Expected ITEMS_AMBIGUOUS_NORMALIZED_SKU in error message, got: ${err.message}`
        );
        return true;
      }
    );
  } finally {
    await pool.query(`DELETE FROM items WHERE id = ANY($1::uuid[])`, [[itemId1, itemId2]]);
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  }
});

test('migration preflight passes when no tenant has ambiguous normalized SKUs', async () => {
  const tenantId = randomUUID();
  const itemId = randomUUID();
  const sku = `UNAMBIG-PREFLIGHT-${randomUUID().slice(0, 8).toUpperCase()}`;

  await pool.query(
    `INSERT INTO tenants (id, name, slug, created_at)
     VALUES ($1, $2, $3, now())`,
    [tenantId, 'Preflight Unambiguous SKU Test Tenant', `preflight-unambig-${tenantId.slice(0, 8)}`]
  );
  try {
    await pool.query(
      `INSERT INTO items (id, tenant_id, sku, name, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [itemId, tenantId, sku, 'Solo Item']
    );

    // Must not throw — unique normalized SKU per tenant is safe.
    await assert.doesNotReject(() => pool.query(AMBIGUOUS_SKU_PREFLIGHT));
  } finally {
    await pool.query(`DELETE FROM items WHERE id = $1`, [itemId]);
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  }
});

test('migration 1794000000000 source contains the ambiguous-SKU preflight logic this test depends on', async () => {
  const migrationPath = resolve(
    process.cwd(),
    'src/migrations/1794000000000_align_import_job_rows_serial_identity.ts'
  );
  const source = await readFile(migrationPath, 'utf8');

  assert.ok(
    source.includes('ITEMS_AMBIGUOUS_NORMALIZED_SKU'),
    'Migration must contain ITEMS_AMBIGUOUS_NORMALIZED_SKU error marker'
  );
  assert.ok(
    source.includes('GROUP BY tenant_id, lower(btrim(sku))'),
    'Migration must group by tenant_id, lower(btrim(sku)) for ambiguity detection'
  );
  assert.ok(
    source.includes('HAVING COUNT(*) > 1'),
    'Migration must use HAVING COUNT(*) > 1 to identify duplicate normalized SKUs'
  );
});
