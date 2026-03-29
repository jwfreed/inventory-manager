import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { WAREHOUSE_DEFAULTS_REPAIR_HINT } from '../config/warehouseDefaultsStartup';
import {
  findOrphanWarehouseRootIssues,
  getWarehouseDefaultLocationId,
  resolveDefaultLocationForRole,
  resolveWarehouseIdForLocation,
  type WarehouseDefaultRepairOptions
} from '../domain/warehouseDefaults/warehouseDefaultsDetection';
import {
  ensureDefaultsForWarehouse,
  ensureOrphanWarehouseRoots,
  validateWarehouseDefaultsState
} from '../domain/warehouseDefaults/warehouseDefaultsRepair';

export {
  findOrphanWarehouseRootIssues,
  getWarehouseDefaultLocationId,
  resolveDefaultLocationForRole,
  resolveWarehouseIdForLocation
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

export async function validateWarehouseDefaults(tenantId?: string): Promise<void> {
  await ensureOrphanWarehouseRoots({
    tenantId,
    repairMode: false,
    scopeKey: orphanWarehouseScopeKey(tenantId),
    orphanWarehouseRootsWarningLoggedByScope
  });
  await validateWarehouseDefaultsState(tenantId, isWarehouseDefaultsRepairEnabled());
}

export async function ensureWarehouseDefaults(tenantId?: string, options?: WarehouseDefaultRepairOptions): Promise<void> {
  const repairMode = resolveWarehouseDefaultsRepairMode(options);
  await ensureOrphanWarehouseRoots({
    tenantId,
    options,
    repairMode,
    scopeKey: orphanWarehouseScopeKey(tenantId),
    orphanWarehouseRootsWarningLoggedByScope
  });
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
      await ensureDefaultsForWarehouse(warehouse.tenant_id, warehouse.id, repairMode, client, options);
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
  const repairMode = resolveWarehouseDefaultsRepairMode(resolvedOptions);
  if (client) {
    await ensureDefaultsForWarehouse(tenantId, warehouseId, repairMode, client, resolvedOptions);
    return;
  }
  await withTransaction(async (tx) => {
    await ensureDefaultsForWarehouse(tenantId, warehouseId, repairMode, tx, resolvedOptions);
  });
}
