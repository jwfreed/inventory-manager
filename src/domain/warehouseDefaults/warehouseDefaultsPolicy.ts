import { warehouseDefaultsPolicyContract } from './warehouseDefaultsPolicy.contract';

export type {
  LocationRole,
  WarehouseDefaultInvalidReason,
  WarehouseDefaultLocationState
} from './warehouseDefaultsPolicy.contract';

export const warehouseDefaultsPolicy = warehouseDefaultsPolicyContract;
export const REQUIRED_DEFAULT_ROLES = warehouseDefaultsPolicy.roles.required;
export const DEFAULT_ROLES = warehouseDefaultsPolicy.roles.all;

export function getWarehouseDefaultLocationType(role: import('./warehouseDefaultsPolicy.contract').LocationRole): 'bin' | 'scrap' {
  return warehouseDefaultsPolicy.defaults.getExpectedLocationType(role);
}

export function warehouseDefaultRoleRequiresSellableFlag(
  role: import('./warehouseDefaultsPolicy.contract').LocationRole
): boolean {
  return warehouseDefaultsPolicy.defaults.requiresSellableFlag(role);
}

export function isRequiredWarehouseDefaultRole(role: import('./warehouseDefaultsPolicy.contract').LocationRole): boolean {
  return warehouseDefaultsPolicy.roles.isRequiredRole(role);
}

export function getMissingRequiredWarehouseDefaultRoles(roles: Iterable<string>) {
  return warehouseDefaultsPolicy.roles.getMissingRequiredRoles(roles);
}

export function buildExpectedWarehouseDefaultState(
  role: import('./warehouseDefaultsPolicy.contract').LocationRole,
  warehouseId: string
) {
  return warehouseDefaultsPolicy.defaults.buildExpectedState(role, warehouseId);
}

export function detectWarehouseDefaultInvalidReason(params: {
  tenantId: string;
  warehouseId: string;
  role: import('./warehouseDefaultsPolicy.contract').LocationRole;
  existingDefault: import('./warehouseDefaultsPolicy.contract').WarehouseDefaultLocationState | null | undefined;
}) {
  return warehouseDefaultsPolicy.defaults.detectInvalidReason(params);
}

export function shouldRepairInvalidWarehouseDefault(
  reason: import('./warehouseDefaultsPolicy.contract').WarehouseDefaultInvalidReason | null
): boolean {
  return warehouseDefaultsPolicy.repair.shouldRepair(reason);
}
