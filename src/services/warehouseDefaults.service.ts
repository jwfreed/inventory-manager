import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db';

export type LocationRole = 'SELLABLE' | 'QA' | 'HOLD' | 'REJECT' | 'SCRAP';

type LocationRow = {
  id: string;
  type: string;
  parent_location_id: string | null;
};

const REQUIRED_DEFAULT_ROLES: LocationRole[] = ['SELLABLE', 'QA', 'HOLD', 'REJECT'];
const DEFAULT_ROLES: LocationRole[] = ['SELLABLE', 'QA', 'HOLD', 'REJECT', 'SCRAP'];

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
  const params: any[] = [];
  const clauses: string[] = [`type = 'warehouse'`];
  if (tenantId) {
    clauses.push(`tenant_id = $${params.push(tenantId)}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const warehousesRes = await query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM locations ${where}`,
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
      const error = new Error('WAREHOUSE_DEFAULT_LOCATIONS_REQUIRED') as Error & { details?: any };
      error.details = { warehouseId: warehouse.id, tenantId: warehouse.tenant_id, missingRoles: missing };
      throw error;
    }
  }
}

async function ensureDefaultsForWarehouse(
  tenantId: string,
  warehouseId: string,
  client?: PoolClient
): Promise<void> {
  const executor = client ? client.query.bind(client) : query;
  const defaultsRes = await executor<{ role: LocationRole; location_id: string }>(
    `SELECT role, location_id
       FROM warehouse_default_location
      WHERE tenant_id = $1 AND warehouse_id = $2`,
    [tenantId, warehouseId]
  );
  const defaults = new Map<LocationRole, string>();
  for (const row of defaultsRes.rows) {
    defaults.set(row.role, row.location_id);
  }

  const roleLocRes = await executor<{ id: string; role: LocationRole }>(
    `SELECT id, role
       FROM locations
      WHERE tenant_id = $1
        AND parent_location_id = $2
        AND role = ANY($3::text[])`,
    [tenantId, warehouseId, DEFAULT_ROLES]
  );
  const roleLocations = new Map<LocationRole, string>();
  for (const row of roleLocRes.rows) {
    if (!roleLocations.has(row.role)) {
      roleLocations.set(row.role, row.id);
    }
  }

  for (const role of DEFAULT_ROLES) {
    if (defaults.has(role)) continue;
    let locationId = roleLocations.get(role) ?? null;
    if (!locationId) {
      const id = uuidv4();
      const code = `${role}-${warehouseId}`;
      const name = `${role} Default`;
      const type = role === 'SCRAP' ? 'scrap' : 'bin';
      const isSellable = role === 'SELLABLE';
      const now = new Date();
      const insertRes = await executor(
        `INSERT INTO locations (
            id,
            tenant_id,
            code,
            name,
            type,
            role,
            is_sellable,
            active,
            parent_location_id,
            created_at,
            updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $9)
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [id, tenantId, code, name, type, role, isSellable, warehouseId, now]
      );
      if (insertRes.rowCount && insertRes.rows[0]?.id) {
        locationId = insertRes.rows[0].id;
        await executor(
          `INSERT INTO config_issues (id, tenant_id, issue_type, entity_type, entity_id, details, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            uuidv4(),
            tenantId,
            'WAREHOUSE_DEFAULT_AUTO_CREATED',
            'location',
            locationId,
            JSON.stringify({ role, warehouseId }),
            now
          ]
        );
      } else {
        const existingLoc = await executor<{ id: string }>(
          `SELECT id FROM locations WHERE tenant_id = $1 AND code = $2`,
          [tenantId, code]
        );
        if (existingLoc.rowCount > 0) {
          locationId = existingLoc.rows[0].id;
        }
      }
    }
    await executor(
      `INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [tenantId, warehouseId, role, locationId]
    );
  }
}

export async function ensureWarehouseDefaults(tenantId?: string): Promise<void> {
  const params: any[] = [];
  const clauses: string[] = [`type = 'warehouse'`];
  if (tenantId) {
    clauses.push(`tenant_id = $${params.push(tenantId)}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const warehousesRes = await query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM locations ${where}`,
    params
  );
  for (const warehouse of warehousesRes.rows) {
    await withTransaction(async (client) => {
      await ensureDefaultsForWarehouse(warehouse.tenant_id, warehouse.id, client);
    });
  }
  await validateWarehouseDefaults(tenantId);
}

export async function ensureWarehouseDefaultsForWarehouse(
  tenantId: string,
  warehouseId: string,
  client?: PoolClient
): Promise<void> {
  await ensureDefaultsForWarehouse(tenantId, warehouseId, client);
}
