export type LocationRole = 'SELLABLE' | 'QA' | 'HOLD' | 'REJECT' | 'SCRAP';

export type WarehouseDefaultInvalidReason =
  | 'missing_warehouse'
  | 'missing_location'
  | 'tenant_mismatch'
  | 'role_mismatch'
  | 'sellable_flag'
  | 'warehouse_drift'
  | 'parent_drift'
  | 'type_mismatch';

export type WarehouseDefaultLocationState = {
  tenant_id: string;
  role: LocationRole;
  parent_location_id: string | null;
  warehouse_id: string;
  type: string;
  is_sellable: boolean;
};

export const REQUIRED_DEFAULT_ROLES: LocationRole[] = ['SELLABLE', 'QA', 'HOLD', 'REJECT'];
export const DEFAULT_ROLES: LocationRole[] = ['SELLABLE', 'QA', 'HOLD', 'REJECT', 'SCRAP'];

export function getWarehouseDefaultLocationType(role: LocationRole): 'bin' | 'scrap' {
  return role === 'SCRAP' ? 'scrap' : 'bin';
}

export function warehouseDefaultRoleRequiresSellableFlag(role: LocationRole): boolean {
  return role === 'SELLABLE';
}

export function isRequiredWarehouseDefaultRole(role: LocationRole): boolean {
  return REQUIRED_DEFAULT_ROLES.includes(role);
}

export function getMissingRequiredWarehouseDefaultRoles(roles: Iterable<string>): LocationRole[] {
  const seen = new Set(roles);
  return REQUIRED_DEFAULT_ROLES.filter((role) => !seen.has(role));
}

export function buildExpectedWarehouseDefaultState(role: LocationRole, warehouseId: string) {
  return {
    role,
    warehouse_id: warehouseId,
    parent_location_id: warehouseId,
    type: getWarehouseDefaultLocationType(role),
    is_sellable: warehouseDefaultRoleRequiresSellableFlag(role) ? true : null
  };
}

export function detectWarehouseDefaultInvalidReason(params: {
  tenantId: string;
  warehouseId: string;
  role: LocationRole;
  existingDefault: WarehouseDefaultLocationState | null | undefined;
}): WarehouseDefaultInvalidReason | null {
  const { tenantId, warehouseId, role, existingDefault } = params;
  if (!existingDefault) return 'missing_location';
  if (existingDefault.tenant_id !== tenantId) return 'tenant_mismatch';
  if (existingDefault.role !== role) return 'role_mismatch';
  if (warehouseDefaultRoleRequiresSellableFlag(role) && existingDefault.is_sellable !== true) return 'sellable_flag';
  if (existingDefault.warehouse_id !== warehouseId) return 'warehouse_drift';
  if (existingDefault.parent_location_id !== warehouseId) return 'parent_drift';
  if (existingDefault.type !== getWarehouseDefaultLocationType(role)) return 'type_mismatch';
  return null;
}

export function shouldRepairInvalidWarehouseDefault(reason: WarehouseDefaultInvalidReason | null): boolean {
  return Boolean(reason && reason !== 'missing_location');
}
