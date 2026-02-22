import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db';
import { WAREHOUSE_DEFAULTS_REPAIR_HINT } from '../config/warehouseDefaultsStartup';
import {
  emitWarehouseDefaultsEvent,
  WAREHOUSE_DEFAULTS_EVENT
} from '../observability/warehouseDefaults.events';
import type { WarehouseDefaultValidationSnapshot } from '../observability/warehouseDefaults.events';

export type LocationRole = 'SELLABLE' | 'QA' | 'HOLD' | 'REJECT' | 'SCRAP';

type LocationRow = {
  id: string;
  type: string;
  parent_location_id: string | null;
};

const REQUIRED_DEFAULT_ROLES: LocationRole[] = ['SELLABLE', 'QA', 'HOLD', 'REJECT'];
const DEFAULT_ROLES: LocationRole[] = ['SELLABLE', 'QA', 'HOLD', 'REJECT', 'SCRAP'];

type WarehouseDefaultRepairOptions = {
  repair?: boolean;
};

type WarehouseDefaultInvalidReason =
  | 'missing_warehouse'
  | 'missing_location'
  | 'tenant_mismatch'
  | 'role_mismatch'
  | 'sellable_flag'
  | 'warehouse_drift'
  | 'parent_drift'
  | 'type_mismatch';

type OrphanWarehouseRootIssue = {
  location_id: string;
  tenant_id: string;
  warehouse_id: string | null;
  parent_location_id: string | null;
  warehouse_tenant_id: string | null;
  warehouse_type: string | null;
  derived_parent_warehouse_id: string | null;
};

const orphanWarehouseRootsWarningLoggedByScope = new Set<string>();

function isWarehouseDefaultsRepairEnabled(): boolean {
  const raw = String(process.env.WAREHOUSE_DEFAULTS_REPAIR ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function resolveWarehouseDefaultsRepairMode(options?: WarehouseDefaultRepairOptions): boolean {
  if (typeof options?.repair === 'boolean') {
    return options.repair;
  }
  return isWarehouseDefaultsRepairEnabled();
}

function orphanWarehouseScopeKey(tenantId?: string): string {
  return tenantId ?? '__all__';
}

function summarizeOrphanWarehouseRootIssues(issues: OrphanWarehouseRootIssue[], tenantId?: string) {
  const sampleWarehouseIds = Array.from(new Set(issues.map((row) => row.warehouse_id).filter((row): row is string => Boolean(row)))).slice(0, 5);
  const sampleTenantIds = Array.from(new Set(issues.map((row) => row.tenant_id))).slice(0, 5);
  return {
    orphanCount: issues.length,
    tenantId: tenantId ?? null,
    sampleWarehouseIds,
    sampleTenantIds
  };
}

function buildWarehouseDefaultExpected(role: LocationRole, warehouseId: string): WarehouseDefaultValidationSnapshot {
  return {
    role,
    warehouse_id: warehouseId,
    parent_location_id: warehouseId,
    type: role === 'SCRAP' ? 'scrap' : 'bin',
    is_sellable: role === 'SELLABLE' ? true : null
  };
}

function buildWarehouseDefaultActual(
  role: LocationRole,
  existingDefault: {
    role: LocationRole;
    parent_location_id: string | null;
    warehouse_id: string;
    type: string;
    is_sellable: boolean;
  } | null | undefined
): WarehouseDefaultValidationSnapshot {
  return {
    role: existingDefault?.role ?? null,
    warehouse_id: existingDefault?.warehouse_id ?? null,
    parent_location_id: existingDefault?.parent_location_id ?? null,
    type: existingDefault?.type ?? null,
    is_sellable: role === 'SELLABLE' ? (existingDefault?.is_sellable ?? null) : null
  };
}

function warehouseDefaultInvalidError(details: {
  tenantId: string;
  warehouseId: string;
  role: LocationRole | null;
  defaultLocationId: string | null;
  mappingId: string | null;
  reason: WarehouseDefaultInvalidReason;
  expected: WarehouseDefaultValidationSnapshot;
  actual: WarehouseDefaultValidationSnapshot;
}, options: { repairEnabled?: boolean } = {}) {
  const error = new Error('WAREHOUSE_DEFAULT_INVALID') as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  const repairEnabled = options.repairEnabled ?? isWarehouseDefaultsRepairEnabled();
  error.code = 'WAREHOUSE_DEFAULT_INVALID';
  error.details = repairEnabled ? details : { ...details, hint: WAREHOUSE_DEFAULTS_REPAIR_HINT };
  return error;
}

function detectWarehouseDefaultInvalidReason(params: {
  tenantId: string;
  warehouseId: string;
  role: LocationRole;
  existingDefault:
    | {
        tenant_id: string;
        role: LocationRole;
        parent_location_id: string | null;
        warehouse_id: string;
        type: string;
        is_sellable: boolean;
      }
    | null
    | undefined;
}): WarehouseDefaultInvalidReason | null {
  const { tenantId, warehouseId, role, existingDefault } = params;
  const expectedType = role === 'SCRAP' ? 'scrap' : 'bin';
  if (!existingDefault) return 'missing_location';
  if (existingDefault.tenant_id !== tenantId) return 'tenant_mismatch';
  if (existingDefault.role !== role) return 'role_mismatch';
  if (role === 'SELLABLE' && existingDefault.is_sellable !== true) return 'sellable_flag';
  if (existingDefault.warehouse_id !== warehouseId) return 'warehouse_drift';
  if (existingDefault.parent_location_id !== warehouseId) return 'parent_drift';
  if (existingDefault.type !== expectedType) return 'type_mismatch';
  return null;
}

async function findOrphanWarehouseRootIssues(tenantId?: string): Promise<OrphanWarehouseRootIssue[]> {
  const issuesRes = await query<OrphanWarehouseRootIssue>(
    `SELECT l.id AS location_id,
            l.tenant_id,
            l.warehouse_id,
            l.parent_location_id,
            wh.tenant_id AS warehouse_tenant_id,
            wh.type AS warehouse_type,
            resolve_warehouse_for_location(l.tenant_id, l.parent_location_id) AS derived_parent_warehouse_id
       FROM locations l
       LEFT JOIN locations wh
         ON wh.id = l.warehouse_id
      WHERE l.type <> 'warehouse'
        AND ($1::uuid IS NULL OR l.tenant_id = $1)
        AND (
          l.warehouse_id IS NULL
          OR wh.id IS NULL
          OR wh.type <> 'warehouse'
          OR wh.tenant_id IS DISTINCT FROM l.tenant_id
        )
      ORDER BY l.created_at ASC, l.id ASC`,
    [tenantId ?? null]
  );
  return issuesRes.rows;
}

async function ensureOrphanWarehouseRoots(tenantId?: string, options?: WarehouseDefaultRepairOptions): Promise<void> {
  const issues = await findOrphanWarehouseRootIssues(tenantId);
  if (issues.length === 0) return;
  const summary = summarizeOrphanWarehouseRootIssues(issues, tenantId);
  const repairMode = resolveWarehouseDefaultsRepairMode(options);
  const scopeKey = orphanWarehouseScopeKey(tenantId);

  if (!repairMode) {
    if (orphanWarehouseRootsWarningLoggedByScope.has(scopeKey)) return;
    orphanWarehouseRootsWarningLoggedByScope.add(scopeKey);
    emitWarehouseDefaultsEvent(WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_DETECTED, summary);
    return;
  }

  emitWarehouseDefaultsEvent(WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRING, summary);

  const now = new Date();
  let createdWarehouseRootsCount = 0;
  const createdWarehouseRootIds: string[] = [];
  const rootsToCreate = new Map<string, { tenantId: string; warehouseId: string }>();
  for (const issue of issues) {
    if (!issue.warehouse_id || issue.warehouse_type !== null) continue;
    if (issue.derived_parent_warehouse_id && issue.derived_parent_warehouse_id !== issue.warehouse_id) continue;
    rootsToCreate.set(`${issue.tenant_id}:${issue.warehouse_id}`, {
      tenantId: issue.tenant_id,
      warehouseId: issue.warehouse_id
    });
  }

  for (const root of rootsToCreate.values()) {
    const code = `WAREHOUSE_RECOVERED_${root.warehouseId.replace(/-/g, '').toUpperCase()}`;
    const insertRes = await query<{ id: string }>(
      `INSERT INTO locations (
          id, tenant_id, code, local_code, name, type, role, is_sellable, active,
          parent_location_id, warehouse_id, created_at, updated_at
       )
       SELECT $1, $2, $3, NULL, $4, 'warehouse', NULL, false, true, NULL, $1, $5, $5
         FROM tenants t
        WHERE t.id = $2
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [root.warehouseId, root.tenantId, code, `Recovered Warehouse ${root.warehouseId.slice(0, 8)}`, now]
    );
    if (insertRes.rowCount > 0) {
      createdWarehouseRootsCount += 1;
      createdWarehouseRootIds.push(insertRes.rows[0].id);
    }
  }

  const reparentRes = await query<{ id: string }>(
    `UPDATE locations l
        SET parent_location_id = l.warehouse_id,
            updated_at = $2
       FROM locations wh
      WHERE ($1::uuid IS NULL OR l.tenant_id = $1)
        AND l.type <> 'warehouse'
        AND l.parent_location_id IS NULL
        AND l.warehouse_id IS NOT NULL
        AND wh.id = l.warehouse_id
        AND wh.tenant_id = l.tenant_id
        AND wh.type = 'warehouse'
      RETURNING l.id`,
    [tenantId ?? null, now]
  );

  const relinkRes = await query<{ id: string }>(
    `WITH candidate AS (
       SELECT l.id,
              resolve_warehouse_for_location(l.tenant_id, l.parent_location_id) AS expected_warehouse_id
         FROM locations l
        WHERE ($1::uuid IS NULL OR l.tenant_id = $1)
          AND l.type <> 'warehouse'
          AND l.parent_location_id IS NOT NULL
     ),
     to_fix AS (
       SELECT c.id,
              c.expected_warehouse_id
         FROM candidate c
         JOIN locations l
           ON l.id = c.id
        WHERE c.expected_warehouse_id IS NOT NULL
          AND l.warehouse_id IS DISTINCT FROM c.expected_warehouse_id
          AND NOT (
            l.local_code IS NOT NULL
            AND EXISTS (
              SELECT 1
                FROM locations dup
               WHERE dup.tenant_id = l.tenant_id
                 AND dup.warehouse_id = c.expected_warehouse_id
                 AND dup.local_code = l.local_code
                 AND dup.id <> l.id
            )
          )
     )
     UPDATE locations l
        SET warehouse_id = f.expected_warehouse_id,
            updated_at = $2
       FROM to_fix f
      WHERE l.id = f.id
     RETURNING l.id`,
    [tenantId ?? null, now]
  );
  const relinkConflictRes = await query<{ count: string }>(
    `WITH candidate AS (
       SELECT l.id,
              l.tenant_id,
              l.local_code,
              l.warehouse_id,
              resolve_warehouse_for_location(l.tenant_id, l.parent_location_id) AS expected_warehouse_id
         FROM locations l
        WHERE ($1::uuid IS NULL OR l.tenant_id = $1)
          AND l.type <> 'warehouse'
          AND l.parent_location_id IS NOT NULL
     )
     SELECT COUNT(*)::text AS count
       FROM candidate c
      WHERE c.expected_warehouse_id IS NOT NULL
        AND c.warehouse_id IS DISTINCT FROM c.expected_warehouse_id
        AND c.local_code IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM locations dup
           WHERE dup.tenant_id = c.tenant_id
             AND dup.warehouse_id = c.expected_warehouse_id
             AND dup.local_code = c.local_code
             AND dup.id <> c.id
        )`,
    [tenantId ?? null]
  );

  const remaining = await findOrphanWarehouseRootIssues(tenantId);
  const remainingSummary = summarizeOrphanWarehouseRootIssues(remaining, tenantId);
  emitWarehouseDefaultsEvent(WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRED, {
    ...summary,
    createdWarehouseRootsCount,
    createdWarehouseRootIds: createdWarehouseRootIds.slice(0, 5),
    reparentedCount: reparentRes.rowCount ?? 0,
    relinkedWarehouseCount: relinkRes.rowCount ?? 0,
    skippedRelinkLocalCodeConflictCount: Number(relinkConflictRes.rows[0]?.count ?? 0),
    remainingCount: remainingSummary.orphanCount,
    remainingSampleWarehouseIds: remainingSummary.sampleWarehouseIds,
    remainingSampleTenantIds: remainingSummary.sampleTenantIds
  });
}

async function insertWarehouseDefaultConfigIssue(params: {
  executor: PoolClient['query'] | typeof query;
  tenantId: string;
  warehouseId: string;
  role: LocationRole;
  locationId: string;
  localCode: string;
  now: Date;
}) {
  const { executor, tenantId, warehouseId, role, locationId, localCode, now } = params;
  const configIssueRes = await executor(
    `INSERT INTO config_issues (id, tenant_id, issue_type, entity_type, entity_id, details, created_at)
     SELECT $1, $2, $3, $4, $5, $6::jsonb, $7
       FROM tenants t
      WHERE t.id = $2`,
    [
      uuidv4(),
      tenantId,
      'WAREHOUSE_DEFAULT_AUTO_CREATED',
      'location',
      locationId,
      JSON.stringify({ role, warehouseId, localCode }),
      now
    ]
  );
  if (configIssueRes.rowCount === 0) {
    console.warn('WAREHOUSE_DEFAULT_CONFIG_ISSUE_SKIPPED_MISSING_TENANT', {
      tenantId,
      warehouseId,
      role,
      context: 'auto_create_default_location',
      locationId,
      localCode
    });
  }
}

async function fetchLocation(
  tenantId: string,
  locationId: string,
  client?: PoolClient
): Promise<LocationRow | null> {
  const executor = client ? client.query.bind(client) : query;
  const res = await executor<LocationRow>(
    `SELECT id, type, parent_location_id
       FROM locations
      WHERE id = $1 AND tenant_id = $2`,
    [locationId, tenantId]
  );
  if (res.rowCount === 0) return null;
  return res.rows[0];
}

export async function resolveWarehouseIdForLocation(
  tenantId: string,
  locationId: string,
  client?: PoolClient
): Promise<string> {
  let currentId: string | null = locationId;
  const visited = new Set<string>();
  let depth = 0;
  while (currentId) {
    depth += 1;
    if (depth > 20) {
      throw new Error('WAREHOUSE_RESOLUTION_DEPTH_EXCEEDED');
    }
    if (visited.has(currentId)) {
      throw new Error('WAREHOUSE_RESOLUTION_CYCLE');
    }
    visited.add(currentId);
    const row = await fetchLocation(tenantId, currentId, client);
    if (!row) break;
    if (row.type === 'warehouse') return row.id;
    currentId = row.parent_location_id;
  }
  throw new Error('WAREHOUSE_RESOLUTION_FAILED');
}

export async function getWarehouseDefaultLocationId(
  tenantId: string,
  warehouseId: string,
  role: LocationRole,
  client?: PoolClient
): Promise<string | null> {
  const executor = client ? client.query.bind(client) : query;
  const res = await executor<{ location_id: string }>(
    `SELECT location_id
       FROM warehouse_default_location
      WHERE tenant_id = $1
        AND warehouse_id = $2
        AND role = $3`,
    [tenantId, warehouseId, role]
  );
  if (res.rowCount === 0) return null;
  return res.rows[0].location_id;
}

export async function resolveDefaultLocationForRole(
  tenantId: string,
  referenceLocationId: string,
  role: LocationRole,
  client?: PoolClient
): Promise<string> {
  const warehouseId = await resolveWarehouseIdForLocation(tenantId, referenceLocationId, client);
  const resolved = await getWarehouseDefaultLocationId(tenantId, warehouseId, role, client);
  if (!resolved) {
    throw new Error('WAREHOUSE_DEFAULT_LOCATION_REQUIRED');
  }
  return resolved;
}

export async function validateWarehouseDefaults(tenantId?: string): Promise<void> {
  await ensureOrphanWarehouseRoots(tenantId, { repair: false });
  const params: any[] = [];
  const clauses: string[] = [`l.type = 'warehouse'`];
  if (tenantId) {
    clauses.push(`l.tenant_id = $${params.push(tenantId)}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const warehousesRes = await query<{ id: string; tenant_id: string }>(
    `SELECT l.id, l.tenant_id
       FROM locations l
       JOIN tenants t
         ON t.id = l.tenant_id
     ${where}`,
    params
  );
  for (const warehouse of warehousesRes.rows) {
    const rolesRes = await query<{ role: string }>(
      `SELECT role FROM warehouse_default_location
        WHERE tenant_id = $1 AND warehouse_id = $2`,
      [warehouse.tenant_id, warehouse.id]
    );
    const roles = new Set(rolesRes.rows.map((row) => row.role));
    const missing = REQUIRED_DEFAULT_ROLES.filter((role) => !roles.has(role));
    if (missing.length > 0) {
      const repairEnabled = isWarehouseDefaultsRepairEnabled();
      const error = new Error('WAREHOUSE_DEFAULT_LOCATIONS_REQUIRED') as Error & { code?: string; details?: any };
      error.code = 'WAREHOUSE_DEFAULT_LOCATIONS_REQUIRED';
      error.details = repairEnabled
        ? { warehouseId: warehouse.id, tenantId: warehouse.tenant_id, missingRoles: missing }
        : {
            warehouseId: warehouse.id,
            tenantId: warehouse.tenant_id,
            missingRoles: missing,
            hint: WAREHOUSE_DEFAULTS_REPAIR_HINT
          };
      throw error;
    }
  }
}

async function ensureDefaultsForWarehouse(
  tenantId: string,
  warehouseId: string,
  client?: PoolClient,
  options?: WarehouseDefaultRepairOptions
): Promise<void> {
  const executor = client ? client.query.bind(client) : query;
  const repairInvalidDefaults = resolveWarehouseDefaultsRepairMode(options);
  const warehouseRes = await executor<{
    role: LocationRole | null;
    is_sellable: boolean;
    parent_location_id: string | null;
  }>(
    `SELECT role, is_sellable, parent_location_id
       FROM locations
      WHERE tenant_id = $1
        AND id = $2
        AND type = 'warehouse'`,
    [tenantId, warehouseId]
  );
  if (warehouseRes.rowCount === 0) {
    throw warehouseDefaultInvalidError({
      tenantId,
      warehouseId,
      role: null,
      defaultLocationId: null,
      mappingId: null,
      reason: 'missing_warehouse',
      expected: {
        role: null,
        warehouse_id: warehouseId,
        parent_location_id: null,
        type: 'warehouse',
        is_sellable: false
      },
      actual: {
        role: null,
        warehouse_id: null,
        parent_location_id: null,
        type: null,
        is_sellable: null
      }
    }, { repairEnabled: repairInvalidDefaults });
  }
  const warehouse = warehouseRes.rows[0];
  if (warehouse.role !== null || warehouse.is_sellable || warehouse.parent_location_id !== null) {
    throw new Error(
      `WAREHOUSE_ROOT_INVALID role=${warehouse.role ?? 'null'} is_sellable=${warehouse.is_sellable} parent_location_id=${warehouse.parent_location_id ?? 'null'}`
    );
  }
  const defaultsRes = await executor<{ role: LocationRole; location_id: string; mapping_id: string | null }>(
    `SELECT role,
            location_id,
            to_jsonb(warehouse_default_location)->>'id' AS mapping_id
       FROM warehouse_default_location
      WHERE tenant_id = $1 AND warehouse_id = $2`,
    [tenantId, warehouseId]
  );
  const defaults = new Map<LocationRole, { locationId: string; mappingId: string | null }>();
  for (const row of defaultsRes.rows) {
    defaults.set(row.role, { locationId: row.location_id, mappingId: row.mapping_id });
  }
  const defaultLocationIds = Array.from(defaults.values()).map((row) => row.locationId);
  const defaultLocationById = new Map<
    string,
    {
      id: string;
      tenant_id: string;
      role: LocationRole;
      parent_location_id: string | null;
      warehouse_id: string;
      type: string;
      is_sellable: boolean;
    }
  >();
  if (defaultLocationIds.length > 0) {
    const defaultLocRes = await executor<{
      id: string;
      tenant_id: string;
      role: LocationRole;
      parent_location_id: string | null;
      warehouse_id: string;
      type: string;
      is_sellable: boolean;
    }>(
      `SELECT id, tenant_id, role, parent_location_id, warehouse_id, type, is_sellable
         FROM locations
        WHERE id = ANY($1::uuid[])`,
      [defaultLocationIds]
    );
    for (const row of defaultLocRes.rows) {
      defaultLocationById.set(row.id, row);
    }
  }
  for (const role of DEFAULT_ROLES) {
    const existingDefaultMapping = defaults.get(role) ?? null;
    const existingDefaultId = existingDefaultMapping?.locationId ?? null;
    const existingDefault = existingDefaultId ? defaultLocationById.get(existingDefaultId) : null;
    const invalidReason = detectWarehouseDefaultInvalidReason({
      tenantId,
      warehouseId,
      role,
      existingDefault
    });
    const invalidDetails = invalidReason
      ? {
          tenantId,
          warehouseId,
          role,
          defaultLocationId: existingDefaultId,
          mappingId: existingDefaultMapping?.mappingId ?? null,
          reason: invalidReason,
          expected: buildWarehouseDefaultExpected(role, warehouseId),
          actual: buildWarehouseDefaultActual(role, existingDefault)
        }
      : null;
    const shouldRepairInvalidDefault = Boolean(invalidReason && invalidReason !== 'missing_location');

    if (defaults.has(role)) {
      if (invalidReason) {
        const invalidError = warehouseDefaultInvalidError(invalidDetails!, { repairEnabled: repairInvalidDefaults });
        if (!repairInvalidDefaults) {
          throw invalidError;
        }
        emitWarehouseDefaultsEvent(WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRING, invalidDetails);
        await executor(
          `DELETE FROM warehouse_default_location
            WHERE tenant_id = $1
              AND warehouse_id = $2
              AND role = $3`,
          [tenantId, warehouseId, role]
        );
        defaults.delete(role);
      }
      if (!invalidReason) continue;
    } else if (shouldRepairInvalidDefault) {
      if (!repairInvalidDefaults) {
        throw warehouseDefaultInvalidError(invalidDetails!, { repairEnabled: repairInvalidDefaults });
      }
      emitWarehouseDefaultsEvent(WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRING, invalidDetails);
    }

    const expectedType = role === 'SCRAP' ? 'scrap' : 'bin';
    const candidateRes = await executor<{ id: string }>(
      `SELECT id
         FROM locations
        WHERE tenant_id = $1
          AND warehouse_id = $2
          AND parent_location_id = $2
          AND role = $3
          AND type = $4
          ${role === 'SELLABLE' ? 'AND is_sellable = true' : ''}
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [tenantId, warehouseId, role, expectedType]
    );
    let locationId = candidateRes.rows[0]?.id ?? null;
    if (!locationId) {
      const id = uuidv4();
      const code = `${role}-${warehouseId}`;
      const name = `${role} Default`;
      const isSellable = role === 'SELLABLE';
      const now = new Date();
      const localCodeCandidates = [role, `${role}_${warehouseId.slice(0, 8)}`];

      for (const localCode of localCodeCandidates) {
        const insertRes = await executor(
          `INSERT INTO locations (
              id,
              tenant_id,
              code,
              local_code,
              name,
              type,
              role,
              is_sellable,
              active,
              parent_location_id,
           warehouse_id,
           created_at,
            updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10, $11, $11)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [id, tenantId, code, localCode, name, expectedType, role, isSellable, warehouseId, warehouseId, now]
        );
        if (insertRes.rowCount && insertRes.rows[0]?.id) {
          locationId = insertRes.rows[0].id;
          await insertWarehouseDefaultConfigIssue({
            executor,
            tenantId,
            warehouseId,
            role,
            locationId,
            localCode,
            now
          });
          break;
        }
        const existingLoc = await executor<{ id: string }>(
          `SELECT id FROM locations WHERE tenant_id = $1 AND code = $2`,
          [tenantId, code]
        );
        if (existingLoc.rowCount > 0) {
          locationId = existingLoc.rows[0].id;
          break;
        }
      }
    }
    if (!locationId) {
      throw new Error('WAREHOUSE_DEFAULT_LOCATION_REQUIRED');
    }
    await executor(
      `INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, warehouse_id, role)
       DO NOTHING`,
      [tenantId, warehouseId, role, locationId]
    );
    if (repairInvalidDefaults && shouldRepairInvalidDefault) {
      const ensuredMappingRes = await executor<{ location_id: string; mapping_id: string | null }>(
        `SELECT location_id,
                to_jsonb(warehouse_default_location)->>'id' AS mapping_id
           FROM warehouse_default_location
          WHERE tenant_id = $1
            AND warehouse_id = $2
            AND role = $3`,
        [tenantId, warehouseId, role]
      );
      emitWarehouseDefaultsEvent(WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRED, {
        ...invalidDetails,
        repaired: {
          tenantId,
          warehouseId,
          role,
          locationId: ensuredMappingRes.rows[0]?.location_id ?? locationId,
          defaultLocationId: ensuredMappingRes.rows[0]?.location_id ?? locationId,
          mappingId: ensuredMappingRes.rows[0]?.mapping_id ?? null
        }
      });
    }
  }
}

export async function ensureWarehouseDefaults(tenantId?: string, options?: WarehouseDefaultRepairOptions): Promise<void> {
  await ensureOrphanWarehouseRoots(tenantId, options);
  const params: any[] = [];
  const clauses: string[] = [`l.type = 'warehouse'`];
  if (tenantId) {
    clauses.push(`l.tenant_id = $${params.push(tenantId)}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const warehousesRes = await query<{ id: string; tenant_id: string }>(
    `SELECT l.id, l.tenant_id
       FROM locations l
       JOIN tenants t
         ON t.id = l.tenant_id
     ${where}`,
    params
  );
  for (const warehouse of warehousesRes.rows) {
    await withTransaction(async (client) => {
      await ensureDefaultsForWarehouse(warehouse.tenant_id, warehouse.id, client, options);
    });
  }
  await validateWarehouseDefaults(tenantId);
}

function isPoolClientLike(candidate: unknown): candidate is PoolClient {
  return Boolean(candidate) && typeof (candidate as PoolClient).query === 'function';
}

export async function ensureWarehouseDefaultsForWarehouse(
  tenantId: string,
  warehouseId: string,
  clientOrOptions?: PoolClient | WarehouseDefaultRepairOptions,
  options?: WarehouseDefaultRepairOptions
): Promise<void> {
  const client = isPoolClientLike(clientOrOptions) ? clientOrOptions : undefined;
  const resolvedOptions = isPoolClientLike(clientOrOptions) ? options : clientOrOptions;
  if (client) {
    await ensureDefaultsForWarehouse(tenantId, warehouseId, client, resolvedOptions);
    return;
  }
  await withTransaction(async (tx) => {
    await ensureDefaultsForWarehouse(tenantId, warehouseId, tx, resolvedOptions);
  });
}
