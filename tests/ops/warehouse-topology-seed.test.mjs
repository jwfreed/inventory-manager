import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { checkWarehouseTopologyDefaults } from '../../scripts/lib/warehouseTopologyCheck.mjs';
import { loadWarehouseTopology } from '../../scripts/lib/warehouseTopology.mjs';
import { seedWarehouseTopologyForTenant } from '../../scripts/seed_warehouse_topology.mjs';

const execFileAsync = promisify(execFile);

async function ensureTopologySession() {
  return ensureDbSession({
    tenantSlug: `topology-seed-${randomUUID().slice(0, 8)}`,
    tenantName: 'Warehouse Topology Seed'
  });
}

async function runTopologyWorkflow(pool, tenantId, options = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    const summary = await seedWarehouseTopologyForTenant(client, tenantId, options);
    await client.query('COMMIT');
    return summary;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function fetchTopologyState(pool, tenantId, topology) {
  const expectedWarehouseCodes = topology.warehouses.map((warehouse) => warehouse.code);
  const expectedLocationCodes = topology.locations.map((location) => location.code);

  const [warehouseRes, locationRes, defaultsRes] = await Promise.all([
    pool.query(
      `SELECT id, code
         FROM locations
        WHERE tenant_id = $1
          AND code = ANY($2::text[])
          AND type = 'warehouse'
        ORDER BY code`,
      [tenantId, expectedWarehouseCodes]
    ),
    pool.query(
      `SELECT id, code, local_code, warehouse_id
         FROM locations
        WHERE tenant_id = $1
          AND code = ANY($2::text[])
        ORDER BY code`,
      [tenantId, expectedLocationCodes]
    ),
    pool.query(
      `SELECT warehouse_id, role, location_id
         FROM warehouse_default_location
        WHERE tenant_id = $1
        ORDER BY warehouse_id, role`,
      [tenantId]
    )
  ]);

  return {
    warehouses: warehouseRes.rows,
    locations: locationRes.rows,
    defaults: defaultsRes.rows
  };
}

test('location uniqueness scopes are tenant code + warehouse local_code', async () => {
  const session = await ensureTopologySession();
  const indexRes = await session.pool.query(
    `SELECT indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'locations'
        AND indexdef ILIKE 'CREATE UNIQUE INDEX%'`
  );
  const defs = indexRes.rows.map((row) => String(row.indexdef ?? ''));

  const hasTenantCode = defs.some((definition) => /\(\s*tenant_id\s*,\s*code\s*\)/i.test(definition));
  const hasTenantWarehouseLocalCode = defs.some((definition) =>
    /\(\s*tenant_id\s*,\s*warehouse_id\s*,\s*local_code\s*\)/i.test(definition)
  );
  const hasGlobalCodeOnly = defs.some(
    (definition) => /\(\s*code\s*\)/i.test(definition) && !/\(\s*tenant_id\s*,\s*code\s*\)/i.test(definition)
  );

  assert.equal(hasTenantCode, true, `expected UNIQUE (tenant_id, code), got: ${JSON.stringify(defs)}`);
  assert.equal(
    hasTenantWarehouseLocalCode,
    true,
    `expected UNIQUE (tenant_id, warehouse_id, local_code), got: ${JSON.stringify(defs)}`
  );
  assert.equal(hasGlobalCodeOnly, false, `expected no global UNIQUE (code), got: ${JSON.stringify(defs)}`);
});

test('check-only detects drift and --fix repairs deterministically', async () => {
  const session = await ensureTopologySession();
  const tenantId = session.tenant?.id;
  assert.ok(tenantId, 'tenantId is required');
  const topology = await loadWarehouseTopology();

  await assert.rejects(
    runTopologyWorkflow(session.pool, tenantId, { topology, fix: false }),
    /TOPOLOGY_DRIFT_DETECTED/
  );

  const summary1 = await runTopologyWorkflow(session.pool, tenantId, { topology, fix: true });
  const state1 = await fetchTopologyState(session.pool, tenantId, topology);
  const summary2 = await runTopologyWorkflow(session.pool, tenantId, { topology, fix: true });
  const state2 = await fetchTopologyState(session.pool, tenantId, topology);

  assert.equal(summary1.mode, 'fix');
  assert.equal(summary2.mode, 'fix');
  assert.equal(summary1.created_warehouses_count, topology.warehouses.length);
  assert.equal(summary1.created_locations_count, topology.locations.length);
  assert.equal(summary2.created_warehouses_count, 0);
  assert.equal(summary2.created_locations_count, 0);
  assert.equal(summary2.defaults_set_count, 0);

  assert.equal(state1.warehouses.length, topology.warehouses.length);
  assert.equal(state2.warehouses.length, topology.warehouses.length);
  assert.equal(state1.locations.length, topology.locations.length);
  assert.equal(state2.locations.length, topology.locations.length);
  assert.deepEqual(state2.warehouses, state1.warehouses, 'warehouse ids/codes must remain stable across reruns');
  assert.deepEqual(state2.locations, state1.locations, 'location ids/codes must remain stable across reruns');
  assert.deepEqual(state2.defaults, state1.defaults, 'default mappings must remain stable across reruns');

  const missingLocalCode = state2.locations.filter((location) => !location.local_code);
  assert.equal(missingLocalCode.length, 0, `expected local_code on canonical locations: ${JSON.stringify(missingLocalCode)}`);

  const check = await checkWarehouseTopologyDefaults(session.pool, tenantId, { topology });
  assert.equal(check.count, 0, JSON.stringify(check.issues.slice(0, 10)));
});

test('local_code SELLABLE can repeat across warehouses but not inside one warehouse', async () => {
  const session = await ensureTopologySession();
  const tenantId = session.tenant?.id;
  assert.ok(tenantId, 'tenantId is required');

  await runTopologyWorkflow(session.pool, tenantId, { fix: true });

  const sellableAcrossWarehouses = await session.pool.query(
    `SELECT COUNT(*)::int AS count
       FROM locations
      WHERE tenant_id = $1
        AND local_code = 'SELLABLE'
        AND type <> 'warehouse'`,
    [tenantId]
  );
  assert.equal(Number(sellableAcrossWarehouses.rows[0]?.count ?? 0), 5);

  const warehouseRes = await session.pool.query(
    `SELECT id
       FROM locations
      WHERE tenant_id = $1
        AND code = 'STORE_THAPAE'
      LIMIT 1`,
    [tenantId]
  );
  const storeWarehouseId = warehouseRes.rows[0]?.id;
  assert.ok(storeWarehouseId, 'expected STORE_THAPAE warehouse');

  const duplicateInsert = session.pool.query(
    `INSERT INTO locations (
        id, tenant_id, code, local_code, name, type, role, is_sellable, active, parent_location_id, warehouse_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'bin', 'SELLABLE', true, true, $6, $6, now(), now())`,
    [randomUUID(), tenantId, `STORE_THAPAE_SELLABLE_DUP_${randomUUID().slice(0, 8)}`, 'SELLABLE', 'Duplicate Sellable', storeWarehouseId]
  );
  await assert.rejects(async () => duplicateInsert, (error) => error?.code === '23505');
});

test('ambiguous SELLABLE candidates fail check-only and --fix', async () => {
  const session = await ensureTopologySession();
  const tenantId = session.tenant?.id;
  assert.ok(tenantId, 'tenantId is required');

  await runTopologyWorkflow(session.pool, tenantId, { fix: true });

  const warehouseRes = await session.pool.query(
    `SELECT id
       FROM locations
      WHERE tenant_id = $1
        AND code = 'STORE_THAPAE'
      LIMIT 1`,
    [tenantId]
  );
  const warehouseId = warehouseRes.rows[0]?.id;
  assert.ok(warehouseId, 'expected STORE_THAPAE warehouse');

  await session.pool.query(
    `INSERT INTO locations (
        id, tenant_id, code, local_code, name, type, role, is_sellable, active, parent_location_id, warehouse_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'bin', 'SELLABLE', true, true, $6, $6, now(), now())`,
    [
      randomUUID(),
      tenantId,
      `STORE_THAPAE_SELLABLE_AMBIG_${randomUUID().slice(0, 8)}`,
      `SELLABLE_AMBIG_${randomUUID().slice(0, 4)}`,
      'Ambiguous Sellable',
      warehouseId
    ]
  );

  const check = await checkWarehouseTopologyDefaults(session.pool, tenantId);
  assert.ok(
    check.issues.some((issue) => issue.issue === 'WAREHOUSE_ROLE_AMBIGUOUS'),
    JSON.stringify(check.issues.slice(0, 10))
  );

  await assert.rejects(
    runTopologyWorkflow(session.pool, tenantId, { fix: false }),
    /WAREHOUSE_ROLE_AMBIGUOUS/
  );
  await assert.rejects(
    runTopologyWorkflow(session.pool, tenantId, { fix: true }),
    /WAREHOUSE_ROLE_AMBIGUOUS/
  );

  const defaultMode = await execFileAsync(
    process.execPath,
    ['scripts/inventory_invariants_check.mjs', '--tenant-id', tenantId, '--limit', '25'],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024
    }
  );
  assert.match(defaultMode.stdout, /\[warehouse_topology_defaults_invalid\] count=/);
  assert.match(defaultMode.stdout, /WAREHOUSE_ROLE_AMBIGUOUS/);
  assert.match(defaultMode.stdout, /manual cleanup required/);

  let strictStdout = '';
  await assert.rejects(
    async () => {
      await execFileAsync(
        process.execPath,
        ['scripts/inventory_invariants_check.mjs', '--tenant-id', tenantId, '--limit', '25'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            INVARIANTS_STRICT: 'true'
          },
          maxBuffer: 1024 * 1024
        }
      );
    },
    (error) => {
      strictStdout = String(error?.stdout ?? '');
      return error?.code === 2;
    }
  );
  assert.match(strictStdout, /\[warehouse_topology_defaults_invalid\] count=/);
});

test('single candidate default remains stable under --fix', async () => {
  const session = await ensureTopologySession();
  const tenantId = session.tenant?.id;
  assert.ok(tenantId, 'tenantId is required');

  await runTopologyWorkflow(session.pool, tenantId, { fix: true });

  const warehouseRes = await session.pool.query(
    `SELECT id
       FROM locations
      WHERE tenant_id = $1
        AND code = 'STORE_THAPAE'
      LIMIT 1`,
    [tenantId]
  );
  const warehouseId = warehouseRes.rows[0]?.id;
  assert.ok(warehouseId, 'expected STORE_THAPAE warehouse');

  const beforeRes = await session.pool.query(
    `SELECT location_id
       FROM warehouse_default_location
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND role = 'SELLABLE'`,
    [tenantId, warehouseId]
  );
  const beforeId = beforeRes.rows[0]?.location_id;
  assert.ok(beforeId, 'expected SELLABLE default');

  const summary = await runTopologyWorkflow(session.pool, tenantId, { fix: true });
  assert.equal(summary.defaults_set_count, 0, 'valid defaults should not be overridden');

  const afterRes = await session.pool.query(
    `SELECT location_id
       FROM warehouse_default_location
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND role = 'SELLABLE'`,
    [tenantId, warehouseId]
  );
  assert.equal(afterRes.rows[0]?.location_id, beforeId);
});

test('fix does not override existing valid defaults', async () => {
  const session = await ensureTopologySession();
  const tenantId = session.tenant?.id;
  assert.ok(tenantId, 'tenantId is required');

  await runTopologyWorkflow(session.pool, tenantId, { fix: true });

  const warehouseRes = await session.pool.query(
    `SELECT id
       FROM locations
      WHERE tenant_id = $1
        AND code = 'STORE_THAPAE'
      LIMIT 1`,
    [tenantId]
  );
  const warehouseId = warehouseRes.rows[0]?.id;
  assert.ok(warehouseId, 'expected STORE_THAPAE warehouse');

  const canonicalRes = await session.pool.query(
    `SELECT id
       FROM locations
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND role = 'SELLABLE'
        AND is_sellable = true
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [tenantId, warehouseId]
  );
  const canonicalId = canonicalRes.rows[0]?.id;
  assert.ok(canonicalId, 'expected canonical SELLABLE location');

  await session.pool.query(
    `UPDATE warehouse_default_location
        SET location_id = $4
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND role = $3`,
    [tenantId, warehouseId, 'SELLABLE', canonicalId]
  );

  const summary = await runTopologyWorkflow(session.pool, tenantId, { fix: true });
  assert.equal(summary.defaults_set_count, 0, 'valid defaults should not be overridden');

  const defaultRes = await session.pool.query(
    `SELECT location_id
      FROM warehouse_default_location
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND role = 'SELLABLE'`,
    [tenantId, warehouseId]
  );
  assert.equal(defaultRes.rows[0]?.location_id, canonicalId);
});

test('inventory invariants script reports clean topology after --fix', async () => {
  const session = await ensureTopologySession();
  const tenantId = session.tenant?.id;
  assert.ok(tenantId, 'tenantId is required');

  await runTopologyWorkflow(session.pool, tenantId, { fix: true });

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['scripts/inventory_invariants_check.mjs', '--tenant-id', tenantId, '--limit', '25'],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024
    }
  );

  assert.equal(stderr.trim(), '', stderr);
  assert.match(stdout, /\[warehouse_topology_defaults_invalid\] count=0/);
});

test('topology --fix succeeds for two tenants with identical canonical codes', async () => {
  const sessionA = await ensureTopologySession();
  const sessionB = await ensureTopologySession();
  const tenantA = sessionA.tenant?.id;
  const tenantB = sessionB.tenant?.id;
  assert.ok(tenantA, 'tenantA is required');
  assert.ok(tenantB, 'tenantB is required');
  assert.notEqual(tenantA, tenantB);

  const topology = await loadWarehouseTopology();
  await runTopologyWorkflow(sessionA.pool, tenantA, { topology, fix: true });
  await runTopologyWorkflow(sessionB.pool, tenantB, { topology, fix: true });

  const sharedCodes = await sessionA.pool.query(
    `SELECT l1.code
       FROM locations l1
       JOIN locations l2
         ON l2.code = l1.code
      WHERE l1.tenant_id = $1
        AND l2.tenant_id = $2
        AND l1.code = ANY($3::text[])
      GROUP BY l1.code
      ORDER BY l1.code`,
    [tenantA, tenantB, topology.locations.map((location) => location.code)]
  );
  assert.ok((sharedCodes.rowCount ?? 0) > 0, 'expected overlapping topology codes across tenants');

  const checkA = await checkWarehouseTopologyDefaults(sessionA.pool, tenantA, { topology });
  const checkB = await checkWarehouseTopologyDefaults(sessionB.pool, tenantB, { topology });
  assert.equal(checkA.count, 0, JSON.stringify(checkA.issues.slice(0, 10)));
  assert.equal(checkB.count, 0, JSON.stringify(checkB.issues.slice(0, 10)));
});
