import { query } from '../../db';
import type { OrphanWarehouseRootIssue } from './warehouseDefaultsDetection';
import { warehouseDefaultsPolicy } from './warehouseDefaultsPolicy';

export type WarehouseTopologyRepairResult = {
  createdWarehouseRootsCount: number;
  createdWarehouseRootIds: string[];
  reparentedCount: number;
  relinkedWarehouseCount: number;
  skippedRelinkLocalCodeConflictCount: number;
};

export async function repairOrphanWarehouseRoots(
  tenantId: string | undefined,
  issues: OrphanWarehouseRootIssue[]
): Promise<WarehouseTopologyRepairResult> {
  const now = new Date();
  let createdWarehouseRootsCount = 0;
  const createdWarehouseRootIds: string[] = [];
  const rootsToCreate = new Map<string, { tenantId: string; warehouseId: string }>();
  for (const issue of issues) {
    if (!warehouseDefaultsPolicy.topology.shouldCreateRecoveredWarehouseRoot(issue)) continue;
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

  return {
    createdWarehouseRootsCount,
    createdWarehouseRootIds: createdWarehouseRootIds.slice(0, 5),
    reparentedCount: reparentRes.rowCount ?? 0,
    relinkedWarehouseCount: relinkRes.rowCount ?? 0,
    skippedRelinkLocalCodeConflictCount: Number(relinkConflictRes.rows[0]?.count ?? 0)
  };
}
