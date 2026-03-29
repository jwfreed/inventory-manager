import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../db';
import { WAREHOUSE_DEFAULTS_REPAIR_HINT } from '../../config/warehouseDefaultsStartup';
import {
  emitWarehouseDefaultsEvent,
  WAREHOUSE_DEFAULTS_EVENT
} from '../../observability/warehouseDefaults.events';
import {
  DEFAULT_ROLES,
  detectWarehouseDefaultInvalidReason,
  listOrphanWarehouseRelinkConflicts,
  REQUIRED_DEFAULT_ROLES,
  type LocationRole,
  type QueryExecutor,
  type WarehouseDefaultRepairOptions
} from './warehouseDefaultsDetection';
import {
  buildWarehouseDefaultActual,
  buildWarehouseDefaultExpected,
  findOrphanWarehouseRootIssuesBestEffort,
  summarizeOrphanWarehouseRootIssues,
  warehouseDefaultInternalDerivedIdWithoutMappingError,
  warehouseDefaultInvalidError,
  warehouseOrphanRootsUnresolvedError
} from './warehouseDefaultsDiagnostics';
import { findOrphanWarehouseRootIssues } from './warehouseDefaultsDetection';

async function insertWarehouseDefaultConfigIssue(params: {
  executor: QueryExecutor;
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

export async function ensureOrphanWarehouseRoots(params: {
  tenantId?: string;
  options?: WarehouseDefaultRepairOptions;
  repairMode: boolean;
  scopeKey: string;
  orphanWarehouseRootsWarningLoggedByScope: Set<string>;
}): Promise<void> {
  const {
    tenantId,
    options,
    repairMode,
    scopeKey,
    orphanWarehouseRootsWarningLoggedByScope
  } = params;
  const detector = options?.orphanIssueDetector ?? findOrphanWarehouseRootIssues;
  const issues = await findOrphanWarehouseRootIssuesBestEffort(detector, tenantId);
  if (issues.length === 0) return;
  const summary = summarizeOrphanWarehouseRootIssues(issues, tenantId);

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
    if ((insertRes.rowCount ?? 0) > 0) {
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

  const remaining = await findOrphanWarehouseRootIssuesBestEffort(detector, tenantId);
  const remainingSummary = summarizeOrphanWarehouseRootIssues(remaining, tenantId);
  if (remainingSummary.orphanCount > 0) {
    throw warehouseOrphanRootsUnresolvedError({
      tenantId: tenantId ?? null,
      remainingCount: remainingSummary.orphanCount,
      skippedRelinkLocalCodeConflictCount: Number(relinkConflictRes.rows[0]?.count ?? 0),
      remainingSampleWarehouseIds: remainingSummary.sampleWarehouseIds,
      remainingSampleTenantIds: remainingSummary.sampleTenantIds,
      conflicts: await listOrphanWarehouseRelinkConflicts(tenantId)
    });
  }

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

export async function validateWarehouseDefaultsState(tenantId: string | undefined, repairEnabled: boolean): Promise<void> {
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

export async function ensureDefaultsForWarehouse(
  tenantId: string,
  warehouseId: string,
  repairInvalidDefaults: boolean,
  client?: PoolClient,
  options?: WarehouseDefaultRepairOptions
): Promise<void> {
  const executor = client ? client.query.bind(client) : query;
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
    const derivedDefaultIdWithoutMapping =
      existingDefaultMapping == null
        ? (options?.debugDerivedDefaultByRole?.[role] ?? null)
        : null;
    if (existingDefaultMapping == null && derivedDefaultIdWithoutMapping != null) {
      throw warehouseDefaultInternalDerivedIdWithoutMappingError({
        tenantId,
        warehouseId,
        role,
        derivedId: derivedDefaultIdWithoutMapping
      });
    }
    const existingDefaultId = existingDefaultMapping?.locationId ?? null;
    if (existingDefaultMapping == null && existingDefaultId != null) {
      throw warehouseDefaultInternalDerivedIdWithoutMappingError({
        tenantId,
        warehouseId,
        role,
        derivedId: existingDefaultId
      });
    }
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
        if (invalidDetails) {
          emitWarehouseDefaultsEvent(WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRING, invalidDetails);
        }
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
      if (invalidDetails) {
        emitWarehouseDefaultsEvent(WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRING, invalidDetails);
      }
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
      if (!repairInvalidDefaults) {
        if (REQUIRED_DEFAULT_ROLES.includes(role)) {
          throw warehouseDefaultInvalidError(invalidDetails!, { repairEnabled: repairInvalidDefaults });
        }
        continue;
      }
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
        if ((insertRes.rowCount ?? 0) > 0 && insertRes.rows[0]?.id) {
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
        if ((existingLoc.rowCount ?? 0) > 0) {
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
    if (repairInvalidDefaults && shouldRepairInvalidDefault && invalidDetails) {
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
