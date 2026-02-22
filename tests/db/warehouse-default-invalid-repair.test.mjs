import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { getDbPool } from '../helpers/dbPool.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  ensureWarehouseDefaults,
  ensureWarehouseDefaultsForWarehouse,
  findOrphanWarehouseRootIssues
} = require('../../src/services/warehouseDefaults.service.ts');
const {
  WAREHOUSE_DEFAULTS_EVENT,
  isWarehouseDefaultsEventPayload
} = require('../../src/observability/warehouseDefaults.events.ts');

const db = getDbPool();

async function createTenant(label) {
  const tenantId = randomUUID();
  await db.query(
    `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
     VALUES ($1, $2, $3, NULL, now())`,
    [tenantId, `Warehouse Default ${label}`, `wh-default-${label}-${randomUUID().slice(0, 8)}`]
  );
  return tenantId;
}

async function createWarehouseRoot(tenantId, label) {
  const warehouseId = randomUUID();
  await db.query(
    `INSERT INTO locations (
        id, tenant_id, code, local_code, name, type, role, is_sellable, active,
        parent_location_id, warehouse_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'warehouse', NULL, false, true, NULL, $1, now(), now())`,
    [
      warehouseId,
      tenantId,
      `WH-${label}-${randomUUID().slice(0, 8)}`,
      `WH-${label}`,
      `Warehouse ${label}`
    ]
  );
  return warehouseId;
}

async function createChildLocation(tenantId, warehouseId, role, isSellable, localCode = role) {
  const locationId = randomUUID();
  await db.query(
    `INSERT INTO locations (
        id, tenant_id, code, local_code, name, type, role, is_sellable, active,
        parent_location_id, warehouse_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'bin', $6, $7, true, $8, $9, now(), now())`,
    [
      locationId,
      tenantId,
      `${localCode}-${randomUUID().slice(0, 8)}`,
      localCode,
      `${localCode} Location`,
      role,
      isSellable,
      warehouseId,
      warehouseId
    ]
  );
  return locationId;
}

async function reparentLocation(tenantId, locationId, newParentLocationId) {
  await db.query(
    `UPDATE locations
        SET parent_location_id = $3,
            updated_at = now()
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, locationId, newParentLocationId]
  );
}

async function setLocationRoleAndSellable(tenantId, locationId, role, isSellable) {
  await db.query(
    `UPDATE locations
        SET role = $3,
            is_sellable = $4,
            updated_at = now()
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, locationId, role, isSellable]
  );
}

async function setDefault(tenantId, warehouseId, role, locationId) {
  await db.query(
    `INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, warehouseId, role, locationId]
  );
}

async function fetchDefaultWithLocation(tenantId, warehouseId, role) {
  const res = await db.query(
    `SELECT d.location_id,
            l.role,
            l.warehouse_id,
            l.parent_location_id,
            l.type,
            l.is_sellable
       FROM warehouse_default_location d
       JOIN locations l
         ON l.id = d.location_id
        AND l.tenant_id = d.tenant_id
      WHERE d.tenant_id = $1
        AND d.warehouse_id = $2
        AND d.role = $3`,
    [tenantId, warehouseId, role]
  );
  return res.rows[0] ?? null;
}

async function countWarehouseDefaults(tenantId, warehouseId) {
  const res = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM warehouse_default_location
      WHERE tenant_id = $1
        AND warehouse_id = $2`,
    [tenantId, warehouseId]
  );
  return Number(res.rows[0]?.count ?? 0);
}

async function fetchLocation(tenantId, locationId) {
  const res = await db.query(
    `SELECT id, tenant_id, role, warehouse_id, parent_location_id, type, is_sellable
       FROM locations
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, locationId]
  );
  return res.rows[0] ?? null;
}

async function updateLocationWarehouseId(tenantId, locationId, warehouseId) {
  await db.query(
    `UPDATE locations
        SET warehouse_id = $3,
            updated_at = now()
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, locationId, warehouseId]
  );
}

async function updateLocationWarehouseAndLocalCode(tenantId, locationId, warehouseId, localCode) {
  await db.query(
    `UPDATE locations
        SET warehouse_id = $3,
            local_code = $4,
            updated_at = now()
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, locationId, warehouseId, localCode]
  );
}

async function inventoryStateCounts(tenantId) {
  const [movements, lines, balances] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS count FROM inventory_movements WHERE tenant_id = $1`, [tenantId]),
    db.query(
      `SELECT COUNT(*)::int AS count
         FROM inventory_movement_lines
        WHERE tenant_id = $1`,
      [tenantId]
    ),
    db.query(`SELECT COUNT(*)::int AS count FROM inventory_balance WHERE tenant_id = $1`, [tenantId])
  ]);
  return {
    movements: Number(movements.rows[0]?.count ?? 0),
    lines: Number(lines.rows[0]?.count ?? 0),
    balances: Number(balances.rows[0]?.count ?? 0)
  };
}

async function cleanupTenant(tenantId) {
  await db.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
}

test('warehouse defaults non-repair mode fails loud with structured WAREHOUSE_DEFAULT_INVALID details', async () => {
  const tenantId = await createTenant('invalid');
  const warehouseId = await createWarehouseRoot(tenantId, 'INVALID');
  const brokenDefaultLocationId = await createChildLocation(tenantId, warehouseId, 'SELLABLE', true);
  await setDefault(tenantId, warehouseId, 'SELLABLE', brokenDefaultLocationId);
  const nonDefaultParentId = await createChildLocation(tenantId, warehouseId, 'QA', false);
  await reparentLocation(tenantId, brokenDefaultLocationId, nonDefaultParentId);

  const previousRepair = process.env.WAREHOUSE_DEFAULTS_REPAIR;
  delete process.env.WAREHOUSE_DEFAULTS_REPAIR;
  try {
    await assert.rejects(
      ensureWarehouseDefaultsForWarehouse(tenantId, warehouseId),
      (error) => {
        assert.equal(error?.code, 'WAREHOUSE_DEFAULT_INVALID');
        assert.equal(error?.details?.tenantId, tenantId);
        assert.equal(error?.details?.warehouseId, warehouseId);
        assert.equal(error?.details?.role, 'SELLABLE');
        assert.equal(error?.details?.defaultLocationId, brokenDefaultLocationId);
        assert.ok(Object.prototype.hasOwnProperty.call(error?.details ?? {}, 'mappingId'));
        assert.equal(error?.details?.reason, 'parent_drift');
        assert.equal(error?.details?.expected?.role, 'SELLABLE');
        assert.equal(error?.details?.expected?.warehouse_id, warehouseId);
        assert.equal(error?.details?.expected?.parent_location_id, warehouseId);
        assert.equal(error?.details?.expected?.type, 'bin');
        assert.equal(error?.details?.expected?.is_sellable, true);
        assert.equal(error?.details?.actual?.role, 'SELLABLE');
        assert.equal(error?.details?.actual?.warehouse_id, warehouseId);
        assert.equal(error?.details?.actual?.parent_location_id, nonDefaultParentId);
        assert.equal(error?.details?.actual?.type, 'bin');
        assert.equal(error?.details?.actual?.is_sellable, true);
        assert.match(String(error?.details?.hint ?? ''), /--repair-defaults|WAREHOUSE_DEFAULTS_REPAIR=true/);
        return true;
      }
    );
  } finally {
    if (previousRepair === undefined) {
      delete process.env.WAREHOUSE_DEFAULTS_REPAIR;
    } else {
      process.env.WAREHOUSE_DEFAULTS_REPAIR = previousRepair;
    }
    await cleanupTenant(tenantId);
  }
});

test('warehouse defaults repair mode repairs invalid mapping and leaves inventory/ledger state unchanged', async () => {
  const tenantId = await createTenant('repair');
  const warehouseId = await createWarehouseRoot(tenantId, 'REPAIR');
  const brokenDefaultLocationId = await createChildLocation(tenantId, warehouseId, 'SELLABLE', true);
  await setDefault(tenantId, warehouseId, 'SELLABLE', brokenDefaultLocationId);
  const nonDefaultParentId = await createChildLocation(tenantId, warehouseId, 'QA', false);
  await reparentLocation(tenantId, brokenDefaultLocationId, nonDefaultParentId);

  const beforeState = await inventoryStateCounts(tenantId);
  const previousRepair = process.env.WAREHOUSE_DEFAULTS_REPAIR;
  process.env.WAREHOUSE_DEFAULTS_REPAIR = 'true';
  const repairLogs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    repairLogs.push(args);
    originalWarn(...args);
  };

  try {
    await ensureWarehouseDefaultsForWarehouse(tenantId, warehouseId);

    const repaired = await fetchDefaultWithLocation(tenantId, warehouseId, 'SELLABLE');
    assert.ok(repaired, 'SELLABLE mapping should exist after repair');
    assert.notEqual(repaired.location_id, brokenDefaultLocationId);
    assert.equal(repaired.role, 'SELLABLE');
    assert.equal(repaired.warehouse_id, warehouseId);
    assert.equal(repaired.parent_location_id, warehouseId);
    assert.equal(repaired.type, 'bin');
    assert.equal(repaired.is_sellable, true);

    const afterState = await inventoryStateCounts(tenantId);
    assert.deepEqual(afterState, beforeState);
    assert.ok(
      repairLogs.some(
        (args) =>
          String(args?.[0] ?? '') === WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRING
          && String(args?.[1]?.reason ?? '') === 'parent_drift'
          && isWarehouseDefaultsEventPayload(WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRING, args?.[1])
      ),
      'Expected WAREHOUSE_DEFAULT_REPAIRING log event'
    );
    assert.ok(
      repairLogs.some(
        (args) =>
          String(args?.[0] ?? '') === WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRED
          && String(args?.[1]?.reason ?? '') === 'parent_drift'
          && String(args?.[1]?.repaired?.locationId ?? '') === String(repaired.location_id)
          && String(args?.[1]?.repaired?.defaultLocationId ?? '') === String(repaired.location_id)
          && isWarehouseDefaultsEventPayload(WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRED, args?.[1])
      ),
      'Expected WAREHOUSE_DEFAULT_REPAIRED log event'
    );
  } finally {
    console.warn = originalWarn;
    if (previousRepair === undefined) {
      delete process.env.WAREHOUSE_DEFAULTS_REPAIR;
    } else {
      process.env.WAREHOUSE_DEFAULTS_REPAIR = previousRepair;
    }
    await cleanupTenant(tenantId);
  }
});

test('warehouse defaults non-repair mode fails loud for SELLABLE role/sellable drift with reason', async () => {
  const tenantId = await createTenant('role-drift-invalid');
  const warehouseId = await createWarehouseRoot(tenantId, 'ROLE-DRIFT-INVALID');
  const brokenDefaultLocationId = await createChildLocation(tenantId, warehouseId, 'SELLABLE', true);
  await setDefault(tenantId, warehouseId, 'SELLABLE', brokenDefaultLocationId);
  await setLocationRoleAndSellable(tenantId, brokenDefaultLocationId, 'QA', false);

  const previousRepair = process.env.WAREHOUSE_DEFAULTS_REPAIR;
  delete process.env.WAREHOUSE_DEFAULTS_REPAIR;
  try {
    await assert.rejects(
      ensureWarehouseDefaultsForWarehouse(tenantId, warehouseId),
      (error) => {
        assert.equal(error?.code, 'WAREHOUSE_DEFAULT_INVALID');
        assert.equal(error?.details?.tenantId, tenantId);
        assert.equal(error?.details?.warehouseId, warehouseId);
        assert.equal(error?.details?.role, 'SELLABLE');
        assert.equal(error?.details?.defaultLocationId, brokenDefaultLocationId);
        assert.ok(Object.prototype.hasOwnProperty.call(error?.details ?? {}, 'mappingId'));
        assert.equal(error?.details?.reason, 'role_mismatch');
        assert.equal(error?.details?.expected?.role, 'SELLABLE');
        assert.equal(error?.details?.expected?.warehouse_id, warehouseId);
        assert.equal(error?.details?.expected?.parent_location_id, warehouseId);
        assert.equal(error?.details?.expected?.type, 'bin');
        assert.equal(error?.details?.expected?.is_sellable, true);
        assert.equal(error?.details?.actual?.role, 'QA');
        assert.equal(error?.details?.actual?.warehouse_id, warehouseId);
        assert.equal(error?.details?.actual?.parent_location_id, warehouseId);
        assert.equal(error?.details?.actual?.type, 'bin');
        assert.equal(error?.details?.actual?.is_sellable, false);
        assert.match(String(error?.details?.hint ?? ''), /--repair-defaults|WAREHOUSE_DEFAULTS_REPAIR=true/);
        return true;
      }
    );
  } finally {
    if (previousRepair === undefined) {
      delete process.env.WAREHOUSE_DEFAULTS_REPAIR;
    } else {
      process.env.WAREHOUSE_DEFAULTS_REPAIR = previousRepair;
    }
    await cleanupTenant(tenantId);
  }
});

test('warehouse defaults repair mode repairs SELLABLE role/sellable drift and leaves inventory/ledger state unchanged', async () => {
  const tenantId = await createTenant('role-drift-repair');
  const warehouseId = await createWarehouseRoot(tenantId, 'ROLE-DRIFT-REPAIR');
  const brokenDefaultLocationId = await createChildLocation(tenantId, warehouseId, 'SELLABLE', true);
  await setDefault(tenantId, warehouseId, 'SELLABLE', brokenDefaultLocationId);
  await setLocationRoleAndSellable(tenantId, brokenDefaultLocationId, 'QA', false);

  const beforeState = await inventoryStateCounts(tenantId);
  const previousRepair = process.env.WAREHOUSE_DEFAULTS_REPAIR;
  process.env.WAREHOUSE_DEFAULTS_REPAIR = 'true';
  const repairLogs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    repairLogs.push(args);
    originalWarn(...args);
  };

  try {
    await ensureWarehouseDefaultsForWarehouse(tenantId, warehouseId);

    const repaired = await fetchDefaultWithLocation(tenantId, warehouseId, 'SELLABLE');
    assert.ok(repaired, 'SELLABLE mapping should exist after repair');
    assert.notEqual(repaired.location_id, brokenDefaultLocationId);
    assert.equal(repaired.role, 'SELLABLE');
    assert.equal(repaired.is_sellable, true);
    assert.equal(repaired.parent_location_id, warehouseId);
    assert.equal(repaired.warehouse_id, warehouseId);
    assert.equal(repaired.type, 'bin');

    const afterState = await inventoryStateCounts(tenantId);
    assert.deepEqual(afterState, beforeState);
    assert.ok(
      repairLogs.some(
        (args) =>
          String(args?.[0] ?? '') === WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRING
          && String(args?.[1]?.reason ?? '') === 'role_mismatch'
          && isWarehouseDefaultsEventPayload(WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRING, args?.[1])
      ),
      'Expected WAREHOUSE_DEFAULT_REPAIRING log event for role mismatch'
    );
    assert.ok(
      repairLogs.some(
        (args) =>
          String(args?.[0] ?? '') === WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRED
          && String(args?.[1]?.reason ?? '') === 'role_mismatch'
          && String(args?.[1]?.repaired?.locationId ?? '') === String(repaired.location_id)
          && String(args?.[1]?.repaired?.defaultLocationId ?? '') === String(repaired.location_id)
          && isWarehouseDefaultsEventPayload(WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRED, args?.[1])
      ),
      'Expected WAREHOUSE_DEFAULT_REPAIRED log event for role mismatch'
    );
  } finally {
    console.warn = originalWarn;
    if (previousRepair === undefined) {
      delete process.env.WAREHOUSE_DEFAULTS_REPAIR;
    } else {
      process.env.WAREHOUSE_DEFAULTS_REPAIR = previousRepair;
    }
    await cleanupTenant(tenantId);
  }
});

test('missing SELLABLE mapping with only QA bin fails as missing default in non-repair mode (not role_mismatch)', async () => {
  const tenantId = await createTenant('missing-sellable');
  const warehouseId = await createWarehouseRoot(tenantId, 'MISSING-SELLABLE');
  const qaLocationId = await createChildLocation(tenantId, warehouseId, 'QA', false);

  const previousRepair = process.env.WAREHOUSE_DEFAULTS_REPAIR;
  delete process.env.WAREHOUSE_DEFAULTS_REPAIR;
  try {
    await assert.rejects(
      ensureWarehouseDefaultsForWarehouse(tenantId, warehouseId),
      (error) => {
        assert.equal(error?.code, 'WAREHOUSE_DEFAULT_INVALID');
        assert.equal(error?.details?.tenantId, tenantId);
        assert.equal(error?.details?.warehouseId, warehouseId);
        assert.equal(error?.details?.role, 'SELLABLE');
        assert.equal(error?.details?.reason, 'missing_location');
        assert.notEqual(error?.details?.reason, 'role_mismatch');
        assert.equal(error?.details?.defaultLocationId, null);
        return true;
      }
    );

    const sellableDefault = await fetchDefaultWithLocation(tenantId, warehouseId, 'SELLABLE');
    assert.equal(sellableDefault, null);
    assert.ok(qaLocationId);
  } finally {
    if (previousRepair === undefined) {
      delete process.env.WAREHOUSE_DEFAULTS_REPAIR;
    } else {
      process.env.WAREHOUSE_DEFAULTS_REPAIR = previousRepair;
    }
    await cleanupTenant(tenantId);
  }
});

test('missing SELLABLE mapping with only QA bin repairs by creating SELLABLE location + mapping in repair mode', async () => {
  const tenantId = await createTenant('missing-sellable-repair');
  const warehouseId = await createWarehouseRoot(tenantId, 'MISSING-SELLABLE-REPAIR');
  const qaLocationId = await createChildLocation(tenantId, warehouseId, 'QA', false);

  const previousRepair = process.env.WAREHOUSE_DEFAULTS_REPAIR;
  process.env.WAREHOUSE_DEFAULTS_REPAIR = 'true';
  try {
    await ensureWarehouseDefaultsForWarehouse(tenantId, warehouseId);

    const sellableDefault = await fetchDefaultWithLocation(tenantId, warehouseId, 'SELLABLE');
    assert.ok(sellableDefault, 'SELLABLE mapping should exist');
    assert.notEqual(sellableDefault.location_id, qaLocationId, 'SELLABLE must not pick QA location');
    assert.equal(sellableDefault.role, 'SELLABLE');
    assert.equal(sellableDefault.warehouse_id, warehouseId);
    assert.equal(sellableDefault.parent_location_id, warehouseId);
    assert.equal(sellableDefault.type, 'bin');
    assert.equal(sellableDefault.is_sellable, true);
  } finally {
    if (previousRepair === undefined) {
      delete process.env.WAREHOUSE_DEFAULTS_REPAIR;
    } else {
      process.env.WAREHOUSE_DEFAULTS_REPAIR = previousRepair;
    }
    await cleanupTenant(tenantId);
  }
});

test('internal guard throws when derived default id exists without mapping row', async () => {
  const tenantId = await createTenant('derived-id-no-mapping');
  const warehouseId = await createWarehouseRoot(tenantId, 'DERIVED-ID-NO-MAPPING');
  const qaLocationId = await createChildLocation(tenantId, warehouseId, 'QA', false, 'QA_DERIVED');

  try {
    await assert.rejects(
      ensureWarehouseDefaultsForWarehouse(tenantId, warehouseId, {
        repair: false,
        debugDerivedDefaultByRole: { SELLABLE: qaLocationId }
      }),
      (error) => {
        assert.equal(error?.code, 'WAREHOUSE_DEFAULT_INTERNAL_DERIVED_ID_WITHOUT_MAPPING');
        assert.equal(error?.details?.tenantId, tenantId);
        assert.equal(error?.details?.warehouseId, warehouseId);
        assert.equal(error?.details?.role, 'SELLABLE');
        assert.equal(error?.details?.derivedId, qaLocationId);
        return true;
      }
    );
  } finally {
    await cleanupTenant(tenantId);
  }
});

test('orphan detection returns derived parent warehouse id for relink candidates', async () => {
  const tenantId = await createTenant('orphan-derived-parent');
  const warehouseId = await createWarehouseRoot(tenantId, 'ORPHAN-DERIVED-PARENT');
  const qaLocationId = await createChildLocation(tenantId, warehouseId, 'QA', false, 'QA_DERIVED_PARENT');
  const orphanLocationId = await createChildLocation(tenantId, warehouseId, 'HOLD', false, 'HOLD_DERIVED_PARENT');
  await updateLocationWarehouseId(tenantId, orphanLocationId, qaLocationId);

  try {
    const issues = await findOrphanWarehouseRootIssues(tenantId);
    const issue = issues.find((row) => String(row.location_id) === String(orphanLocationId));
    assert.ok(issue, 'expected orphan detection to include orphan row');
    assert.equal(issue.parent_location_id, warehouseId);
    assert.equal(issue.warehouse_id, qaLocationId);
    assert.equal(issue.warehouse_type, 'bin');
    assert.equal(issue.derived_parent_warehouse_id, warehouseId);
  } finally {
    await cleanupTenant(tenantId);
  }
});

test('orphan detection failure is best-effort and does not crash defaults startup flow', async () => {
  const tenantId = await createTenant('orphan-detection-fail');
  const warehouseId = await createWarehouseRoot(tenantId, 'ORPHAN-DETECTION-FAIL');
  await createChildLocation(tenantId, warehouseId, 'SELLABLE', true, 'SELLABLE_DETECTION_FAIL');
  await createChildLocation(tenantId, warehouseId, 'QA', false, 'QA_DETECTION_FAIL');
  await createChildLocation(tenantId, warehouseId, 'HOLD', false, 'HOLD_DETECTION_FAIL');
  await createChildLocation(tenantId, warehouseId, 'REJECT', false, 'REJECT_DETECTION_FAIL');

  const warningLogs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    if (String(args?.[0] ?? '') === WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_DETECTION_FAILED) {
      warningLogs.push(args);
    }
    originalWarn(...args);
  };

  try {
    await ensureWarehouseDefaults(tenantId, {
      repair: false,
      orphanIssueDetector: async () => {
        const error = new Error('forced orphan detection failure');
        error.code = 'XX000';
        error.detail = 'forced detail';
        error.schema = 'public';
        error.table = 'locations';
        error.constraint = 'uq_locations_tenant_warehouse_local_code';
        error.routine = 'resolve_warehouse_for_location';
        throw error;
      }
    });

    const defaultsCount = await countWarehouseDefaults(tenantId, warehouseId);
    assert.equal(defaultsCount, 4, 'defaults pipeline should continue after detection failure');

    assert.ok(
      warningLogs.some(
        (args) =>
          String(args?.[0] ?? '') === WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_DETECTION_FAILED
          && String(args?.[1]?.tenantId ?? '') === tenantId
          && String(args?.[1]?.error?.code ?? '') === 'XX000'
          && String(args?.[1]?.error?.message ?? '').includes('forced orphan detection failure')
          && String(args?.[1]?.error?.detail ?? '') === 'forced detail'
          && String(args?.[1]?.error?.schema ?? '') === 'public'
          && String(args?.[1]?.error?.table ?? '') === 'locations'
          && String(args?.[1]?.error?.constraint ?? '') === 'uq_locations_tenant_warehouse_local_code'
          && String(args?.[1]?.error?.routine ?? '') === 'resolve_warehouse_for_location'
          && isWarehouseDefaultsEventPayload(WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_DETECTION_FAILED, args?.[1])
      ),
      'expected orphan detection failure to be emitted as best-effort event'
    );
  } finally {
    console.warn = originalWarn;
    await cleanupTenant(tenantId);
  }
});

test('orphan warehouse root drift warning is tenant-scoped and repair mode relinks warehouse_id', async () => {
  const tenantId = await createTenant('orphan-root');
  const warehouseId = await createWarehouseRoot(tenantId, 'ORPHAN-ROOT');
  await ensureWarehouseDefaultsForWarehouse(tenantId, warehouseId, { repair: true });
  const qaLocationId = await createChildLocation(tenantId, warehouseId, 'QA', false, 'QA_ORPHAN_ROOT');
  const driftedLocationId = await createChildLocation(tenantId, warehouseId, 'HOLD', false, 'HOLD_ORPHAN');
  await updateLocationWarehouseId(tenantId, driftedLocationId, qaLocationId);

  const previousRepair = process.env.WAREHOUSE_DEFAULTS_REPAIR;
  const warningLogs = [];
  const repairLogs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    if (String(args?.[0] ?? '') === WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_DETECTED) {
      warningLogs.push(args);
    }
    if (
      String(args?.[0] ?? '') === WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRING
      || String(args?.[0] ?? '') === WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRED
    ) {
      repairLogs.push(args);
    }
    originalWarn(...args);
  };

  try {
    delete process.env.WAREHOUSE_DEFAULTS_REPAIR;
    await ensureWarehouseDefaults(tenantId, { repair: false });

    const nonRepairLocation = await fetchLocation(tenantId, driftedLocationId);
    assert.equal(nonRepairLocation?.warehouse_id, qaLocationId, 'non-repair mode must not silently relink');
    assert.ok(
      warningLogs.some(
        (args) =>
          String(args?.[0] ?? '') === WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_DETECTED
          && String(args?.[1]?.tenantId ?? '') === tenantId
          && isWarehouseDefaultsEventPayload(WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_DETECTED, args?.[1])
      ),
      'expected tenant-scoped orphan warning in non-repair mode'
    );

    process.env.WAREHOUSE_DEFAULTS_REPAIR = 'true';
    await ensureWarehouseDefaults(tenantId, { repair: true });

    const repairedLocation = await fetchLocation(tenantId, driftedLocationId);
    assert.equal(repairedLocation?.warehouse_id, warehouseId, 'repair mode should relink to the real warehouse root');
    assert.ok(
      repairLogs.some(
        (args) =>
          String(args?.[0] ?? '') === WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRING
          && String(args?.[1]?.tenantId ?? '') === tenantId
          && isWarehouseDefaultsEventPayload(WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRING, args?.[1])
      ),
      'expected orphan root repair start log'
    );
    assert.ok(
      repairLogs.some(
        (args) =>
          String(args?.[0] ?? '') === WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRED
          && String(args?.[1]?.tenantId ?? '') === tenantId
          && Number(args?.[1]?.relinkedWarehouseCount ?? 0) >= 1
          && isWarehouseDefaultsEventPayload(WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRED, args?.[1])
      ),
      'expected orphan root repair completion log'
    );
  } finally {
    console.warn = originalWarn;
    if (previousRepair === undefined) {
      delete process.env.WAREHOUSE_DEFAULTS_REPAIR;
    } else {
      process.env.WAREHOUSE_DEFAULTS_REPAIR = previousRepair;
    }
    await cleanupTenant(tenantId);
  }
});

test('orphan repair mode skips conflicting relink instead of failing startup', async () => {
  const tenantId = await createTenant('orphan-conflict');
  const warehouseId = await createWarehouseRoot(tenantId, 'ORPHAN-CONFLICT');
  await ensureWarehouseDefaultsForWarehouse(tenantId, warehouseId, { repair: true });
  const qaLocationId = await createChildLocation(tenantId, warehouseId, 'QA', false, 'QA_ORPHAN_CONFLICT');
  const conflictingHoldLocationId = await createChildLocation(tenantId, warehouseId, 'HOLD', false, 'HOLD_CONFLICT');
  await updateLocationWarehouseAndLocalCode(tenantId, conflictingHoldLocationId, qaLocationId, 'HOLD');

  const previousRepair = process.env.WAREHOUSE_DEFAULTS_REPAIR;
  const repairLogs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    if (
      String(args?.[0] ?? '') === WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRING
      || String(args?.[0] ?? '') === WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRED
    ) {
      repairLogs.push(args);
    }
    originalWarn(...args);
  };

  try {
    await ensureWarehouseDefaults(tenantId, { repair: false });

    process.env.WAREHOUSE_DEFAULTS_REPAIR = 'true';
    await ensureWarehouseDefaults(tenantId, { repair: true });

    const afterRepairLocation = await fetchLocation(tenantId, conflictingHoldLocationId);
    assert.equal(afterRepairLocation?.warehouse_id, qaLocationId, 'conflicting relink should be skipped safely');
    assert.ok(
      repairLogs.some(
        (args) =>
          String(args?.[0] ?? '') === WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRED
          && String(args?.[1]?.tenantId ?? '') === tenantId
          && Number(args?.[1]?.skippedRelinkLocalCodeConflictCount ?? 0) >= 1
          && isWarehouseDefaultsEventPayload(WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRED, args?.[1])
      ),
      'expected repair summary to report skipped local-code conflict relinks'
    );
  } finally {
    console.warn = originalWarn;
    if (previousRepair === undefined) {
      delete process.env.WAREHOUSE_DEFAULTS_REPAIR;
    } else {
      process.env.WAREHOUSE_DEFAULTS_REPAIR = previousRepair;
    }
    await cleanupTenant(tenantId);
  }
});
