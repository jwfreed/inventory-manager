import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

test('locations schema allows role-less, non-sellable warehouse roots', async () => {
  const roleRes = await pool.query(
    `SELECT is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'locations' AND column_name = 'role'`
  );
  assert.equal(roleRes.rows[0]?.is_nullable, 'YES');
  assert.equal(roleRes.rows[0]?.column_default, null);

  const sellableRes = await pool.query(
    `SELECT column_default
       FROM information_schema.columns
      WHERE table_name = 'locations' AND column_name = 'is_sellable'`
  );
  const sellableDefault = sellableRes.rows[0]?.column_default ?? '';
  assert.ok(
    sellableDefault === 'false' || String(sellableDefault).includes('false'),
    `Expected is_sellable default false, got ${sellableDefault}`
  );

  const invalidRootsRes = await pool.query(
    `SELECT COUNT(*) AS count
       FROM locations
      WHERE type = 'warehouse'
        AND parent_location_id IS NULL
        AND (role IS NOT NULL OR is_sellable IS TRUE)`
  );
  assert.equal(Number(invalidRootsRes.rows[0]?.count ?? 0), 0);
});

test.after(async () => {
  await pool.end();
});
