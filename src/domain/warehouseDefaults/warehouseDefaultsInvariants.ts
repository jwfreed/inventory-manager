import {
  warehouseDefaultsPolicyContract,
  type LocationRole,
  type RecoveredWarehouseRootCandidate,
  type WarehouseDefaultLocationState,
  type WarehouseDefaultsInvariantName,
  type WarehouseRootLocationState
} from './warehouseDefaultsPolicy.contract';

export type WarehouseDefaultsInvariant<TContext, TResult = boolean> = {
  name: WarehouseDefaultsInvariantName;
  description: string;
  evaluate: (context: TContext) => TResult;
};

type WarehouseDefaultsInvariantRegistry = {
  warehouse_has_valid_root: WarehouseDefaultsInvariant<WarehouseRootLocationState>;
  default_roles_present: WarehouseDefaultsInvariant<{ roles: Iterable<string> }, { valid: boolean; missingRoles: LocationRole[] }>;
  default_location_state_valid: WarehouseDefaultsInvariant<{
    tenantId: string;
    warehouseId: string;
    role: LocationRole;
    existingDefault: WarehouseDefaultLocationState | null | undefined;
  }>;
  default_location_type_valid: WarehouseDefaultsInvariant<{ role: LocationRole; type: string | null }>;
  default_location_sellable_flag_valid: WarehouseDefaultsInvariant<{
    role: LocationRole;
    existingDefault: WarehouseDefaultLocationState | null | undefined;
  }>;
  recovered_warehouse_root_eligible: WarehouseDefaultsInvariant<RecoveredWarehouseRootCandidate>;
  unresolved_orphan_reason_classified: WarehouseDefaultsInvariant<{ conflictCount: number }, 'local_code_conflict' | 'remaining_orphan_roots'>;
};

export const warehouseDefaultsInvariants: WarehouseDefaultsInvariantRegistry = {
  warehouse_has_valid_root: {
    ...warehouseDefaultsPolicyContract.invariants.warehouse_has_valid_root,
    evaluate: (context: WarehouseRootLocationState) => warehouseDefaultsPolicyContract.topology.isWarehouseRootValid(context)
  },
  default_roles_present: {
    ...warehouseDefaultsPolicyContract.invariants.default_roles_present,
    evaluate: (context: { roles: Iterable<string> }) => {
      const missingRoles = warehouseDefaultsPolicyContract.roles.getMissingRequiredRoles(context.roles);
      return {
        valid: missingRoles.length === 0,
        missingRoles
      };
    }
  },
  default_location_state_valid: {
    ...warehouseDefaultsPolicyContract.invariants.default_location_state_valid,
    evaluate: (context: {
      tenantId: string;
      warehouseId: string;
      role: LocationRole;
      existingDefault: WarehouseDefaultLocationState | null | undefined;
    }) => warehouseDefaultsPolicyContract.defaults.detectInvalidReason(context) === null
  },
  default_location_type_valid: {
    ...warehouseDefaultsPolicyContract.invariants.default_location_type_valid,
    evaluate: (context: { role: LocationRole; type: string | null }) =>
      context.type === warehouseDefaultsPolicyContract.defaults.getExpectedLocationType(context.role)
  },
  default_location_sellable_flag_valid: {
    ...warehouseDefaultsPolicyContract.invariants.default_location_sellable_flag_valid,
    evaluate: (context: {
      role: LocationRole;
      existingDefault: WarehouseDefaultLocationState | null | undefined;
    }) =>
      !warehouseDefaultsPolicyContract.defaults.requiresSellableFlag(context.role)
      || (context.existingDefault?.is_sellable ?? null) === true
  },
  recovered_warehouse_root_eligible: {
    ...warehouseDefaultsPolicyContract.invariants.recovered_warehouse_root_eligible,
    evaluate: (context: RecoveredWarehouseRootCandidate) =>
      warehouseDefaultsPolicyContract.topology.shouldCreateRecoveredWarehouseRoot(context)
  },
  unresolved_orphan_reason_classified: {
    ...warehouseDefaultsPolicyContract.invariants.unresolved_orphan_reason_classified,
    evaluate: (context: { conflictCount: number }) =>
      warehouseDefaultsPolicyContract.topology.getUnresolvedOrphanWarehouseRootsReason(context.conflictCount)
  }
};

export const warehouseDefaultsInvariantRegistry = Object.values(warehouseDefaultsInvariants);
