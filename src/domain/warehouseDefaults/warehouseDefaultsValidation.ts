import { query } from '../../db';
import { WAREHOUSE_DEFAULTS_REPAIR_HINT } from '../../config/warehouseDefaultsStartup';
import { warehouseDefaultsPolicy } from './warehouseDefaultsPolicy';

export async function validateWarehouseDefaultsState(
  tenantId: string | undefined,
  repairEnabled: boolean
): Promise<void> {
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
    const missing = warehouseDefaultsPolicy.roles.getMissingRequiredRoles(rolesRes.rows.map((row) => row.role));
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
