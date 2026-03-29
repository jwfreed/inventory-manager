import {
  warehouseDefaultsPolicyContract,
  type LocationRole,
  type RecoveredWarehouseRootCandidate,
  type WarehouseDefaultInvalidReason,
  type WarehouseDefaultLocationState,
  type WarehouseDefaultsInvariantName,
  type WarehouseRootLocationState
} from './warehouseDefaultsPolicy.contract';

export type WarehouseDefaultsInvariant<TContext, TResult = boolean> = {
  name: WarehouseDefaultsInvariantName;
  description: string;
  evaluate: (context: TContext) => TResult;
};

export type WarehouseDefaultsInvariantOutcome<TReason extends string> = {
  valid: boolean;
  reason: TReason | null;
};

type WarehouseDefaultsInvariantRegistry = {
  warehouse_has_valid_root: WarehouseDefaultsInvariant<WarehouseRootLocationState>;
  default_roles_present: WarehouseDefaultsInvariant<{ roles: Iterable<string> }, { valid: boolean; missingRoles: LocationRole[] }>;
  default_location_state_valid: WarehouseDefaultsInvariant<{
    tenantId: string;
    warehouseId: string;
    role: LocationRole;
    existingDefault: WarehouseDefaultLocationState | null | undefined;
  }, WarehouseDefaultsInvariantOutcome<
    Extract<
      WarehouseDefaultInvalidReason,
      'missing_location' | 'tenant_mismatch' | 'role_mismatch' | 'warehouse_drift' | 'parent_drift'
    >
  >>;
  default_location_type_valid: WarehouseDefaultsInvariant<{
    role: LocationRole;
    existingDefault: WarehouseDefaultLocationState | null | undefined;
  }, WarehouseDefaultsInvariantOutcome<'type_mismatch'>>;
  default_location_sellable_flag_valid: WarehouseDefaultsInvariant<{
    role: LocationRole;
    existingDefault: WarehouseDefaultLocationState | null | undefined;
  }, WarehouseDefaultsInvariantOutcome<'sellable_flag'>>;
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
    }) => {
      if (!context.existingDefault) return { valid: false, reason: 'missing_location' };
      if (context.existingDefault.tenant_id !== context.tenantId) return { valid: false, reason: 'tenant_mismatch' };
      if (context.existingDefault.role !== context.role) return { valid: false, reason: 'role_mismatch' };
      if (context.existingDefault.warehouse_id !== context.warehouseId) return { valid: false, reason: 'warehouse_drift' };
      if (context.existingDefault.parent_location_id !== context.warehouseId) return { valid: false, reason: 'parent_drift' };
      return { valid: true, reason: null };
    }
  },
  default_location_type_valid: {
    ...warehouseDefaultsPolicyContract.invariants.default_location_type_valid,
    evaluate: (context: {
      role: LocationRole;
      existingDefault: WarehouseDefaultLocationState | null | undefined;
    }) => {
      if (!context.existingDefault) return { valid: true, reason: null };
      return {
        valid: context.existingDefault.type === warehouseDefaultsPolicyContract.defaults.getExpectedLocationType(context.role),
        reason:
          context.existingDefault.type === warehouseDefaultsPolicyContract.defaults.getExpectedLocationType(context.role)
            ? null
            : 'type_mismatch'
      };
    }
  },
  default_location_sellable_flag_valid: {
    ...warehouseDefaultsPolicyContract.invariants.default_location_sellable_flag_valid,
    evaluate: (context: {
      role: LocationRole;
      existingDefault: WarehouseDefaultLocationState | null | undefined;
    }) => {
      if (!warehouseDefaultsPolicyContract.defaults.requiresSellableFlag(context.role)) {
        return { valid: true, reason: null };
      }
      if (!context.existingDefault) {
        return { valid: true, reason: null };
      }
      return {
        valid: context.existingDefault.is_sellable === true,
        reason: context.existingDefault.is_sellable === true ? null : 'sellable_flag'
      };
    }
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
