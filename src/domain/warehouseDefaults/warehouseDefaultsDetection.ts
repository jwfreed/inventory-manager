import type { PoolClient } from 'pg';
import { query } from '../../db';

export type LocationRole = 'SELLABLE' | 'QA' | 'HOLD' | 'REJECT' | 'SCRAP';

type LocationRow = {
  id: string;
  type: string;
  parent_location_id: string | null;
};

export const REQUIRED_DEFAULT_ROLES: LocationRole[] = ['SELLABLE', 'QA', 'HOLD', 'REJECT'];
export const DEFAULT_ROLES: LocationRole[] = ['SELLABLE', 'QA', 'HOLD', 'REJECT', 'SCRAP'];

export type WarehouseDefaultRepairOptions = {
  repair?: boolean;
  orphanIssueDetector?: OrphanIssueDetector;
  // Test-only hook used to verify guardrails against role-unsafe derived defaults.
  debugDerivedDefaultByRole?: Partial<Record<LocationRole, string | null>>;
};

export type WarehouseDefaultInvalidReason =
  | 'missing_warehouse'
  | 'missing_location'
  | 'tenant_mismatch'
  | 'role_mismatch'
  | 'sellable_flag'
  | 'warehouse_drift'
  | 'parent_drift'
  | 'type_mismatch';

export type OrphanWarehouseRootIssue = {
  location_id: string;
  tenant_id: string;
  warehouse_id: string | null;
  parent_location_id: string | null;
  warehouse_tenant_id: string | null;
  warehouse_type: string | null;
  derived_parent_warehouse_id: string | null;
};

export type OrphanWarehouseRelinkConflict = {
  tenantId: string;
  warehouseId: string;
  locationId: string;
  conflictingLocationId: string;
  localCode: string;
  currentWarehouseId: string | null;
  reason: 'local_code_conflict';
};

export type OrphanIssueDetector = (tenantId?: string) => Promise<OrphanWarehouseRootIssue[]>;
export type QueryExecutor = (
  text: string,
  values?: unknown[]
) => Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;

export function detectWarehouseDefaultInvalidReason(params: {
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

export async function findOrphanWarehouseRootIssues(tenantId?: string): Promise<OrphanWarehouseRootIssue[]> {
  const tenantClause = tenantId ? 'AND l.tenant_id = $1' : '';
  const params = tenantId ? [tenantId] : [];
  const issuesRes = await query<OrphanWarehouseRootIssue>(
    `SELECT l.id AS location_id,
            l.tenant_id,
            l.warehouse_id,
            l.parent_location_id,
            wh.tenant_id AS warehouse_tenant_id,
            wh.type AS warehouse_type,
            CASE
              WHEN l.parent_location_id IS NULL THEN NULL
              ELSE resolve_warehouse_for_location(l.tenant_id, l.parent_location_id)
            END AS derived_parent_warehouse_id
       FROM locations l
       LEFT JOIN locations wh
         ON wh.id = l.warehouse_id
      WHERE l.type <> 'warehouse'
        ${tenantClause}
        AND (
          l.warehouse_id IS NULL
          OR wh.id IS NULL
          OR wh.type <> 'warehouse'
          OR wh.tenant_id IS DISTINCT FROM l.tenant_id
        )
      ORDER BY l.created_at ASC, l.id ASC`,
    params
  );
  return issuesRes.rows;
}

export async function listOrphanWarehouseRelinkConflicts(tenantId?: string): Promise<OrphanWarehouseRelinkConflict[]> {
  const conflictsRes = await query<{
    tenant_id: string;
    warehouse_id: string;
    location_id: string;
    conflicting_location_id: string;
    local_code: string;
    current_warehouse_id: string | null;
  }>(
    `WITH candidate AS (
       SELECT l.id AS location_id,
              l.tenant_id,
              l.local_code,
              l.warehouse_id AS current_warehouse_id,
              resolve_warehouse_for_location(l.tenant_id, l.parent_location_id) AS expected_warehouse_id
         FROM locations l
        WHERE ($1::uuid IS NULL OR l.tenant_id = $1)
          AND l.type <> 'warehouse'
          AND l.parent_location_id IS NOT NULL
     )
     SELECT c.tenant_id,
            c.expected_warehouse_id AS warehouse_id,
            c.location_id,
            dup.id AS conflicting_location_id,
            c.local_code,
            c.current_warehouse_id
       FROM candidate c
       JOIN locations dup
         ON dup.tenant_id = c.tenant_id
        AND dup.warehouse_id = c.expected_warehouse_id
        AND dup.local_code = c.local_code
        AND dup.id <> c.location_id
      WHERE c.expected_warehouse_id IS NOT NULL
        AND c.current_warehouse_id IS DISTINCT FROM c.expected_warehouse_id
        AND c.local_code IS NOT NULL
      ORDER BY c.location_id ASC, dup.id ASC
      LIMIT 10`,
    [tenantId ?? null]
  );
  return conflictsRes.rows.map((row) => ({
    tenantId: row.tenant_id,
    warehouseId: row.warehouse_id,
    locationId: row.location_id,
    conflictingLocationId: row.conflicting_location_id,
    localCode: row.local_code,
    currentWarehouseId: row.current_warehouse_id,
    reason: 'local_code_conflict'
  }));
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
