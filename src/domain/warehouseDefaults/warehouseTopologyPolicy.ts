import { warehouseDefaultsPolicyContract } from './warehouseDefaultsPolicy.contract';

export const warehouseTopologyPolicy = warehouseDefaultsPolicyContract.topology;

export function isWarehouseRootLocationValid(
  params: import('./warehouseDefaultsPolicy.contract').WarehouseRootLocationState
): boolean {
  return warehouseTopologyPolicy.isWarehouseRootValid(params);
}

export function formatWarehouseRootInvalidMessage(
  params: import('./warehouseDefaultsPolicy.contract').WarehouseRootLocationState
): string {
  return warehouseTopologyPolicy.formatWarehouseRootInvalidMessage(params);
}

export function shouldCreateRecoveredWarehouseRoot(
  params: import('./warehouseDefaultsPolicy.contract').RecoveredWarehouseRootCandidate
): params is {
  warehouse_id: string;
  warehouse_type: null;
  derived_parent_warehouse_id: string | null;
} {
  return warehouseTopologyPolicy.shouldCreateRecoveredWarehouseRoot(params);
}

export function getUnresolvedOrphanWarehouseRootsReason(
  conflictCount: number
): 'local_code_conflict' | 'remaining_orphan_roots' {
  return warehouseTopologyPolicy.getUnresolvedOrphanWarehouseRootsReason(conflictCount);
}
