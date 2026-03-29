import { WAREHOUSE_DEFAULTS_REPAIR_HINT } from '../../config/warehouseDefaultsStartup';
import type { WarehouseDefaultValidationSnapshot } from '../../observability/warehouseDefaults.events';
import { buildWarehouseDefaultActual, buildWarehouseDefaultExpected, warehouseDefaultInvalidError } from './warehouseDefaultsDiagnostics';
import { warehouseDefaultsInvariants, type WarehouseDefaultsInvariantOutcome } from './warehouseDefaultsInvariants';
import type {
  LocationRole,
  WarehouseDefaultInvalidReason,
  WarehouseDefaultLocationState,
  WarehouseRootLocationState
} from './warehouseDefaultsPolicy.contract';
import { warehouseDefaultsPolicyContract } from './warehouseDefaultsPolicy.contract';

export type WarehouseDefaultsRoleContext = {
  defaultLocationId: string | null;
  mappingId: string | null;
  existingDefault: WarehouseDefaultLocationState | null | undefined;
};

export type WarehouseDefaultsInvariantEngineContext = {
  tenantId: string;
  warehouseId: string;
  warehouseRoot?: WarehouseRootLocationState | null;
  mappedRoles?: Iterable<string>;
  defaultsByRole?: Partial<Record<LocationRole, WarehouseDefaultsRoleContext>>;
};

export type WarehouseDefaultsInvariantEngineScope = {
  includeRoot?: boolean;
  includeRequiredRoles?: boolean;
  includeRoleStates?: boolean;
};

export type WarehouseDefaultsInvariantFailure = {
  invariant:
    | 'warehouse_has_valid_root'
    | 'default_roles_present'
    | 'default_location_state_valid'
    | 'default_location_type_valid'
    | 'default_location_sellable_flag_valid';
  errorCode: 'WAREHOUSE_DEFAULT_INVALID' | 'WAREHOUSE_DEFAULT_LOCATIONS_REQUIRED' | 'WAREHOUSE_ROOT_INVALID';
  repairBehavior: {
    requiresMappingDeletion: boolean;
    shouldRepair: boolean;
    shouldProvisionLocation: boolean;
    blocksValidation: boolean;
  };
  role?: LocationRole;
  reason?: WarehouseDefaultInvalidReason | 'missing_required_roles';
  missingRoles?: LocationRole[];
  defaultLocationId?: string | null;
  mappingId?: string | null;
  expected?: WarehouseDefaultValidationSnapshot;
  actual?: WarehouseDefaultValidationSnapshot;
  invalidMessage?: string;
};

export type WarehouseDefaultsRoleEvaluation = WarehouseDefaultsRoleContext & {
  role: LocationRole;
  failures: WarehouseDefaultsRoleInvariantFailure[];
  invalidReason: WarehouseDefaultInvalidReason | null;
  invariant:
    | 'default_location_state_valid'
    | 'default_location_type_valid'
    | 'default_location_sellable_flag_valid'
    | null;
  repairBehavior: WarehouseDefaultsInvariantFailure['repairBehavior'];
};

export type WarehouseDefaultsInvariantEngineResult = {
  valid: boolean;
  failures: WarehouseDefaultsInvariantFailure[];
  missingRoles: LocationRole[];
  roleEvaluations: Record<LocationRole, WarehouseDefaultsRoleEvaluation>;
};

function normalizeScope(scope: WarehouseDefaultsInvariantEngineScope = {}): Required<WarehouseDefaultsInvariantEngineScope> {
  return {
    includeRoot: scope.includeRoot ?? true,
    includeRequiredRoles: scope.includeRequiredRoles ?? true,
    includeRoleStates: scope.includeRoleStates ?? true
  };
}

type WarehouseDefaultsRoleInvariantFailure = {
  invariant: Exclude<WarehouseDefaultsRoleEvaluation['invariant'], null>;
  reason: WarehouseDefaultInvalidReason;
};

const INVALID_REASON_PRIORITY: WarehouseDefaultInvalidReason[] = [
  'missing_location',
  'tenant_mismatch',
  'role_mismatch',
  'sellable_flag',
  'warehouse_drift',
  'parent_drift',
  'type_mismatch'
];

function buildNeutralRepairBehavior(): WarehouseDefaultsInvariantFailure['repairBehavior'] {
  return {
    requiresMappingDeletion: false,
    shouldRepair: false,
    shouldProvisionLocation: false,
    blocksValidation: false
  };
}

function deriveInvalidReasonFromFailures(
  failures: WarehouseDefaultsRoleInvariantFailure[]
): WarehouseDefaultInvalidReason | null {
  for (const reason of INVALID_REASON_PRIORITY) {
    if (failures.some((failure) => failure.reason === reason)) {
      return reason;
    }
  }
  return null;
}

function getPrimaryFailure(
  failures: WarehouseDefaultsRoleInvariantFailure[]
): WarehouseDefaultsRoleInvariantFailure | null {
  const reason = deriveInvalidReasonFromFailures(failures);
  if (!reason) return null;
  return failures.find((failure) => failure.reason === reason) ?? null;
}

function buildRepairBehaviorFromFailure(
  role: LocationRole,
  failure: WarehouseDefaultsRoleInvariantFailure | null
): WarehouseDefaultsInvariantFailure['repairBehavior'] {
  if (!failure) {
    return buildNeutralRepairBehavior();
  }
  if (failure.invariant === 'default_location_state_valid' && failure.reason === 'missing_location') {
    return {
      requiresMappingDeletion: false,
      shouldRepair: false,
      shouldProvisionLocation: true,
      blocksValidation: warehouseDefaultsPolicyContract.roles.isRequiredRole(role)
    };
  }
  return {
    requiresMappingDeletion: true,
    shouldRepair: true,
    shouldProvisionLocation: true,
    blocksValidation: true
  };
}

function buildRoleFailure(params: {
  tenantId: string;
  warehouseId: string;
  role: LocationRole;
  failure: WarehouseDefaultsRoleInvariantFailure;
  defaultLocationId: string | null;
  mappingId: string | null;
  existingDefault: WarehouseDefaultLocationState | null | undefined;
}): WarehouseDefaultsInvariantFailure {
  const { tenantId, warehouseId, role, failure, defaultLocationId, mappingId, existingDefault } = params;
  return {
    invariant: failure.invariant,
    errorCode: 'WAREHOUSE_DEFAULT_INVALID',
    repairBehavior: buildRepairBehaviorFromFailure(role, failure),
    role,
    reason: failure.reason,
    defaultLocationId,
    mappingId,
    expected: buildWarehouseDefaultExpected(role, warehouseId),
    actual: buildWarehouseDefaultActual(role, existingDefault)
  };
}

function buildRoleEvaluation(
  tenantId: string,
  warehouseId: string,
  role: LocationRole,
  context?: WarehouseDefaultsRoleContext
): WarehouseDefaultsRoleEvaluation {
  const existingDefault = context?.existingDefault ?? null;
  const stateOutcome = warehouseDefaultsInvariants.default_location_state_valid.evaluate({
    tenantId,
    warehouseId,
    role,
    existingDefault
  });
  const typeOutcome = warehouseDefaultsInvariants.default_location_type_valid.evaluate({
    role,
    existingDefault
  });
  const sellableOutcome = warehouseDefaultsInvariants.default_location_sellable_flag_valid.evaluate({
    role,
    existingDefault
  });
  const failures: WarehouseDefaultsRoleInvariantFailure[] = [];
  const pushOutcome = <TReason extends WarehouseDefaultInvalidReason>(
    invariant: Exclude<WarehouseDefaultsRoleEvaluation['invariant'], null>,
    outcome: WarehouseDefaultsInvariantOutcome<TReason>
  ) => {
    if (!outcome.valid && outcome.reason) {
      failures.push({ invariant, reason: outcome.reason });
    }
  };
  pushOutcome('default_location_state_valid', stateOutcome);
  pushOutcome('default_location_type_valid', typeOutcome);
  pushOutcome('default_location_sellable_flag_valid', sellableOutcome);
  const primaryFailure = getPrimaryFailure(failures);
  return {
    role,
    defaultLocationId: context?.defaultLocationId ?? null,
    mappingId: context?.mappingId ?? null,
    existingDefault,
    failures,
    invalidReason: primaryFailure?.reason ?? null,
    invariant: primaryFailure?.invariant ?? null,
    repairBehavior: buildRepairBehaviorFromFailure(role, primaryFailure)
  };
}

function buildMissingRolesError(tenantId: string, warehouseId: string, missingRoles: LocationRole[], repairEnabled: boolean) {
  const error = new Error('WAREHOUSE_DEFAULT_LOCATIONS_REQUIRED') as Error & { code?: string; details?: any };
  error.code = 'WAREHOUSE_DEFAULT_LOCATIONS_REQUIRED';
  error.details = repairEnabled
    ? { warehouseId, tenantId, missingRoles }
    : { warehouseId, tenantId, missingRoles, hint: WAREHOUSE_DEFAULTS_REPAIR_HINT };
  return error;
}

export const warehouseDefaultsInvariantEngine = {
  evaluate(
    context: WarehouseDefaultsInvariantEngineContext,
    scope?: WarehouseDefaultsInvariantEngineScope
  ): WarehouseDefaultsInvariantEngineResult {
    const resolvedScope = normalizeScope(scope);
    const failures: WarehouseDefaultsInvariantFailure[] = [];
    const roleEvaluations = Object.fromEntries(
      warehouseDefaultsPolicyContract.roles.all.map((role) => [
        role,
        buildRoleEvaluation(context.tenantId, context.warehouseId, role, context.defaultsByRole?.[role])
      ])
    ) as Record<LocationRole, WarehouseDefaultsRoleEvaluation>;

    let missingRoles: LocationRole[] = [];
    if (resolvedScope.includeRoot && context.warehouseRoot) {
      if (!warehouseDefaultsInvariants.warehouse_has_valid_root.evaluate(context.warehouseRoot)) {
        failures.push({
          invariant: 'warehouse_has_valid_root',
          errorCode: 'WAREHOUSE_ROOT_INVALID',
          repairBehavior: { ...buildNeutralRepairBehavior(), blocksValidation: true },
          invalidMessage: warehouseDefaultsPolicyContract.topology.formatWarehouseRootInvalidMessage(context.warehouseRoot)
        });
      }
    }

    if (resolvedScope.includeRequiredRoles) {
      const rolesPresent = warehouseDefaultsInvariants.default_roles_present.evaluate({
        roles: context.mappedRoles ?? []
      });
      missingRoles = rolesPresent.missingRoles;
      if (!rolesPresent.valid) {
        failures.push({
          invariant: 'default_roles_present',
          errorCode: 'WAREHOUSE_DEFAULT_LOCATIONS_REQUIRED',
          repairBehavior: {
            requiresMappingDeletion: false,
            shouldRepair: false,
            shouldProvisionLocation: true,
            blocksValidation: true
          },
          reason: 'missing_required_roles',
          missingRoles
        });
      }
    }

    if (resolvedScope.includeRoleStates) {
      for (const role of warehouseDefaultsPolicyContract.roles.all) {
        const evaluation = roleEvaluations[role];
        for (const failure of evaluation.failures) {
          failures.push(
            buildRoleFailure({
              tenantId: context.tenantId,
              warehouseId: context.warehouseId,
              role,
              failure,
              defaultLocationId: evaluation.defaultLocationId,
              mappingId: evaluation.mappingId,
              existingDefault: evaluation.existingDefault
            })
          );
        }
      }
    }

    failures.sort((left, right) => {
      const invariantCompare = left.invariant.localeCompare(right.invariant);
      if (invariantCompare !== 0) return invariantCompare;
      const roleCompare = (left.role ?? '').localeCompare(right.role ?? '');
      if (roleCompare !== 0) return roleCompare;
      return (left.reason ?? '').localeCompare(right.reason ?? '');
    });

    return {
      valid: failures.length === 0,
      failures,
      missingRoles,
      roleEvaluations
    };
  },

  getFailures(
    context: WarehouseDefaultsInvariantEngineContext,
    scope?: WarehouseDefaultsInvariantEngineScope
  ): WarehouseDefaultsInvariantFailure[] {
    return this.evaluate(context, scope).failures;
  },

  assertValid(
    context: WarehouseDefaultsInvariantEngineContext,
    options: { repairEnabled?: boolean; scope?: WarehouseDefaultsInvariantEngineScope } = {}
  ): void {
    const evaluation = this.evaluate(context, options.scope);
    const repairEnabled = options.repairEnabled ?? false;
    for (const failure of evaluation.failures) {
      if (failure.errorCode === 'WAREHOUSE_ROOT_INVALID' && failure.invalidMessage) {
        throw new Error(failure.invalidMessage);
      }
      if (failure.errorCode === 'WAREHOUSE_DEFAULT_LOCATIONS_REQUIRED' && failure.missingRoles) {
        throw buildMissingRolesError(context.tenantId, context.warehouseId, failure.missingRoles, repairEnabled);
      }
      if (
        failure.errorCode === 'WAREHOUSE_DEFAULT_INVALID'
        && failure.role
        && failure.reason
        && failure.reason !== 'missing_required_roles'
        && failure.expected
        && failure.actual
      ) {
        throw warehouseDefaultInvalidError(
          {
            tenantId: context.tenantId,
            warehouseId: context.warehouseId,
            role: failure.role,
            defaultLocationId: failure.defaultLocationId ?? null,
            mappingId: failure.mappingId ?? null,
            reason: failure.reason,
            expected: failure.expected,
            actual: failure.actual
          },
          { repairEnabled }
        );
      }
    }
  }
};

export function evaluateWarehouseDefaultsInvariants(
  context: WarehouseDefaultsInvariantEngineContext,
  scope?: WarehouseDefaultsInvariantEngineScope
) {
  return warehouseDefaultsInvariantEngine.evaluate(context, scope);
}
