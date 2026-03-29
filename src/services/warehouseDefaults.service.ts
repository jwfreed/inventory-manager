import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db';
import { emitWarehouseDefaultsEvent, WAREHOUSE_DEFAULTS_EVENT } from '../observability/warehouseDefaults.events';
import {
  findOrphanWarehouseRootIssues,
  listOrphanWarehouseRelinkConflicts,
  getWarehouseDefaultLocationId,
  resolveDefaultLocationForRole,
  resolveWarehouseIdForLocation,
  type WarehouseDefaultRepairOptions
} from '../domain/warehouseDefaults/warehouseDefaultsDetection';
import {
  buildOrphanDetectionFailurePayload,
  summarizeOrphanWarehouseRootIssues,
  warehouseOrphanRootsUnresolvedError
} from '../domain/warehouseDefaults/warehouseDefaultsDiagnostics';
import {
  ensureDefaultsForWarehouse,
  type DefaultLocationRepairCallbacks
} from '../domain/warehouseDefaults/warehouseDefaultLocationRepair';
import { repairOrphanWarehouseRoots } from '../domain/warehouseDefaults/warehouseTopologyRepair';
import { validateWarehouseDefaultsState } from '../domain/warehouseDefaults/warehouseDefaultsValidation';

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

async function findOrphanWarehouseRootIssuesBestEffort(
  detector: (tenantId?: string) => Promise<Awaited<ReturnType<typeof findOrphanWarehouseRootIssues>>>,
  tenantId?: string
) {
  try {
    return await detector(tenantId);
  } catch (error) {
    emitWarehouseDefaultsEvent(
      WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_DETECTION_FAILED,
      buildOrphanDetectionFailurePayload(tenantId, error)
    );
    return [];
  }
}

async function ensureOrphanWarehouseRoots(params: {
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
  const repairResult = await repairOrphanWarehouseRoots(tenantId, issues);

  const remaining = await findOrphanWarehouseRootIssuesBestEffort(detector, tenantId);
  const remainingSummary = summarizeOrphanWarehouseRootIssues(remaining, tenantId);
  if (remainingSummary.orphanCount > 0) {
    throw warehouseOrphanRootsUnresolvedError({
      tenantId: tenantId ?? null,
      remainingCount: remainingSummary.orphanCount,
      skippedRelinkLocalCodeConflictCount: repairResult.skippedRelinkLocalCodeConflictCount,
      remainingSampleWarehouseIds: remainingSummary.sampleWarehouseIds,
      remainingSampleTenantIds: remainingSummary.sampleTenantIds,
      conflicts: await listOrphanWarehouseRelinkConflicts(tenantId)
    });
  }

  emitWarehouseDefaultsEvent(WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRED, {
    ...summary,
    ...repairResult,
    remainingCount: remainingSummary.orphanCount,
    remainingSampleWarehouseIds: remainingSummary.sampleWarehouseIds,
    remainingSampleTenantIds: remainingSummary.sampleTenantIds
  });
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
      await ensureDefaultsForWarehouse(
        warehouse.tenant_id,
        warehouse.id,
        repairMode,
        client,
        options,
        buildDefaultLocationRepairCallbacks(client)
      );
    });
  }
  await validateWarehouseDefaults(tenantId);
}

function isPoolClientLike(candidate: unknown): candidate is PoolClient {
  return Boolean(candidate) && typeof (candidate as PoolClient).query === 'function';
}

function buildDefaultLocationRepairCallbacks(client?: PoolClient): DefaultLocationRepairCallbacks {
  const executor = client ? client.query.bind(client) : query;
  return {
    onRepairing: (payload) => emitWarehouseDefaultsEvent(WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRING, payload),
    onRepaired: (payload) => emitWarehouseDefaultsEvent(WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRED, payload),
    onAutoCreatedDefaultLocation: async ({ tenantId, warehouseId, role, locationId, localCode, now }) => {
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
          locationId,
          localCode,
          context: 'auto_create_default_location'
        });
      }
    }
  };
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
    await ensureDefaultsForWarehouse(
      tenantId,
      warehouseId,
      repairMode,
      client,
      resolvedOptions,
      buildDefaultLocationRepairCallbacks(client)
    );
    return;
  }
  await withTransaction(async (tx) => {
    await ensureDefaultsForWarehouse(
      tenantId,
      warehouseId,
      repairMode,
      tx,
      resolvedOptions,
      buildDefaultLocationRepairCallbacks(tx)
    );
  });
}
