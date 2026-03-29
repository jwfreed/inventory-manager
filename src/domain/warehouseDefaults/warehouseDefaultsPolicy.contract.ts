export const WAREHOUSE_DEFAULT_LOCATION_ROLES = ['SELLABLE', 'QA', 'HOLD', 'REJECT', 'SCRAP'] as const;
export type LocationRole = (typeof WAREHOUSE_DEFAULT_LOCATION_ROLES)[number];

export const REQUIRED_WAREHOUSE_DEFAULT_ROLES = ['SELLABLE', 'QA', 'HOLD', 'REJECT'] as const satisfies readonly LocationRole[];

export const WAREHOUSE_DEFAULT_INVALID_REASONS = [
  'missing_warehouse',
  'missing_location',
  'tenant_mismatch',
  'role_mismatch',
  'sellable_flag',
  'warehouse_drift',
  'parent_drift',
  'type_mismatch'
] as const;
export type WarehouseDefaultInvalidReason = (typeof WAREHOUSE_DEFAULT_INVALID_REASONS)[number];

export type WarehouseDefaultLocationState = {
  tenant_id: string;
  role: LocationRole;
  parent_location_id: string | null;
  warehouse_id: string;
  type: string;
  is_sellable: boolean;
};

export type WarehouseRootLocationState = {
  role: string | null;
  is_sellable: boolean;
  parent_location_id: string | null;
};

export type RecoveredWarehouseRootCandidate = {
  warehouse_id: string | null;
  warehouse_type: string | null;
  derived_parent_warehouse_id: string | null;
};

export type WarehouseDefaultRepairDecision = {
  reason: WarehouseDefaultInvalidReason | null;
  requiresMappingDeletion: boolean;
  shouldRepair: boolean;
};

const EXPECTED_PROPERTIES_BY_ROLE: Record<
  LocationRole,
  { type: 'bin' | 'scrap'; is_sellable: true | null; required: boolean }
> = {
  SELLABLE: { type: 'bin', is_sellable: true, required: true },
  QA: { type: 'bin', is_sellable: null, required: true },
  HOLD: { type: 'bin', is_sellable: null, required: true },
  REJECT: { type: 'bin', is_sellable: null, required: true },
  SCRAP: { type: 'scrap', is_sellable: null, required: false }
};

const WAREHOUSE_DEFAULTS_INVARIANT_DEFINITIONS = {
  warehouse_has_valid_root: {
    name: 'warehouse_has_valid_root',
    description: 'Warehouse roots must have null role, false sellable flag, and no parent location.'
  },
  default_roles_present: {
    name: 'default_roles_present',
    description: 'Each warehouse must define mappings for every required default role.'
  },
  default_location_state_valid: {
    name: 'default_location_state_valid',
    description: 'A mapped default location must satisfy the expected tenant, role, warehouse, parent, type, and sellable semantics for its role.'
  },
  default_location_type_valid: {
    name: 'default_location_type_valid',
    description: 'SCRAP defaults must use scrap locations; all other defaults must use bin locations.'
  },
  default_location_sellable_flag_valid: {
    name: 'default_location_sellable_flag_valid',
    description: 'SELLABLE defaults must set is_sellable = true; non-sellable roles do not require that flag.'
  },
  recovered_warehouse_root_eligible: {
    name: 'recovered_warehouse_root_eligible',
    description: 'A recovered warehouse root may only be created for orphan issues with a missing warehouse row and no conflicting derived parent warehouse.'
  },
  unresolved_orphan_reason_classified: {
    name: 'unresolved_orphan_reason_classified',
    description: 'Unresolved orphan warehouse roots must classify as local_code_conflict when conflicts remain, otherwise remaining_orphan_roots.'
  }
} as const;

export type WarehouseDefaultsInvariantName = keyof typeof WAREHOUSE_DEFAULTS_INVARIANT_DEFINITIONS;

function getExpectedLocationType(role: LocationRole): 'bin' | 'scrap' {
  return EXPECTED_PROPERTIES_BY_ROLE[role].type;
}

function requiresSellableFlag(role: LocationRole): boolean {
  return EXPECTED_PROPERTIES_BY_ROLE[role].is_sellable === true;
}

function isRequiredRole(role: LocationRole): boolean {
  return EXPECTED_PROPERTIES_BY_ROLE[role].required;
}

function getMissingRequiredRoles(roles: Iterable<string>): LocationRole[] {
  const seen = new Set(roles);
  return REQUIRED_WAREHOUSE_DEFAULT_ROLES.filter((role) => !seen.has(role));
}

function buildExpectedState(role: LocationRole, warehouseId: string) {
  return {
    role,
    warehouse_id: warehouseId,
    parent_location_id: warehouseId,
    type: EXPECTED_PROPERTIES_BY_ROLE[role].type,
    is_sellable: EXPECTED_PROPERTIES_BY_ROLE[role].is_sellable
  };
}

function detectInvalidReason(params: {
  tenantId: string;
  warehouseId: string;
  role: LocationRole;
  existingDefault: WarehouseDefaultLocationState | null | undefined;
}): WarehouseDefaultInvalidReason | null {
  const { tenantId, warehouseId, role, existingDefault } = params;
  if (!existingDefault) return 'missing_location';
  if (existingDefault.tenant_id !== tenantId) return 'tenant_mismatch';
  if (existingDefault.role !== role) return 'role_mismatch';
  if (requiresSellableFlag(role) && existingDefault.is_sellable !== true) return 'sellable_flag';
  if (existingDefault.warehouse_id !== warehouseId) return 'warehouse_drift';
  if (existingDefault.parent_location_id !== warehouseId) return 'parent_drift';
  if (existingDefault.type !== getExpectedLocationType(role)) return 'type_mismatch';
  return null;
}

function getRepairDecision(reason: WarehouseDefaultInvalidReason | null): WarehouseDefaultRepairDecision {
  return {
    reason,
    requiresMappingDeletion: reason !== null,
    shouldRepair: Boolean(reason && reason !== 'missing_location')
  };
}

function shouldRepair(reason: WarehouseDefaultInvalidReason | null): boolean {
  return getRepairDecision(reason).shouldRepair;
}

function isWarehouseRootValid(params: WarehouseRootLocationState): boolean {
  return params.role === null && params.is_sellable === false && params.parent_location_id === null;
}

function formatWarehouseRootInvalidMessage(params: WarehouseRootLocationState): string {
  return `WAREHOUSE_ROOT_INVALID role=${params.role ?? 'null'} is_sellable=${params.is_sellable} parent_location_id=${params.parent_location_id ?? 'null'}`;
}

function shouldCreateRecoveredWarehouseRoot(params: RecoveredWarehouseRootCandidate): params is {
  warehouse_id: string;
  warehouse_type: null;
  derived_parent_warehouse_id: string | null;
} {
  if (!params.warehouse_id || params.warehouse_type !== null) return false;
  if (params.derived_parent_warehouse_id && params.derived_parent_warehouse_id !== params.warehouse_id) return false;
  return true;
}

function getUnresolvedOrphanWarehouseRootsReason(conflictCount: number): 'local_code_conflict' | 'remaining_orphan_roots' {
  return conflictCount > 0 ? 'local_code_conflict' : 'remaining_orphan_roots';
}

export const warehouseDefaultsPolicyContract = {
  roles: {
    all: [...WAREHOUSE_DEFAULT_LOCATION_ROLES],
    required: [...REQUIRED_WAREHOUSE_DEFAULT_ROLES],
    expectedByRole: EXPECTED_PROPERTIES_BY_ROLE,
    isRequiredRole,
    getMissingRequiredRoles
  },
  defaults: {
    getExpectedLocationType,
    requiresSellableFlag,
    buildExpectedState,
    detectInvalidReason
  },
  repair: {
    shouldRepair,
    getRepairDecision
  },
  topology: {
    isWarehouseRootValid,
    formatWarehouseRootInvalidMessage,
    shouldCreateRecoveredWarehouseRoot,
    getUnresolvedOrphanWarehouseRootsReason
  },
  invariants: WAREHOUSE_DEFAULTS_INVARIANT_DEFINITIONS
} as const;
