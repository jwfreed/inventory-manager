export function isWarehouseRootLocationValid(params: {
  role: string | null;
  is_sellable: boolean;
  parent_location_id: string | null;
}): boolean {
  return params.role === null && params.is_sellable === false && params.parent_location_id === null;
}

export function formatWarehouseRootInvalidMessage(params: {
  role: string | null;
  is_sellable: boolean;
  parent_location_id: string | null;
}): string {
  return `WAREHOUSE_ROOT_INVALID role=${params.role ?? 'null'} is_sellable=${params.is_sellable} parent_location_id=${params.parent_location_id ?? 'null'}`;
}

export function shouldCreateRecoveredWarehouseRoot(params: {
  warehouse_id: string | null;
  warehouse_type: string | null;
  derived_parent_warehouse_id: string | null;
}): params is {
  warehouse_id: string;
  warehouse_type: null;
  derived_parent_warehouse_id: string | null;
} {
  if (!params.warehouse_id || params.warehouse_type !== null) return false;
  if (params.derived_parent_warehouse_id && params.derived_parent_warehouse_id !== params.warehouse_id) return false;
  return true;
}

export function getUnresolvedOrphanWarehouseRootsReason(conflictCount: number): 'local_code_conflict' | 'remaining_orphan_roots' {
  return conflictCount > 0 ? 'local_code_conflict' : 'remaining_orphan_roots';
}
