import { WAREHOUSE_DEFAULTS_REPAIR_HINT } from '../../config/warehouseDefaultsStartup';
import type { WarehouseDefaultValidationSnapshot } from '../../observability/warehouseDefaults.events';
import { buildWarehouseDefaultActual, buildWarehouseDefaultExpected, warehouseDefaultInvalidError } from './warehouseDefaultsDiagnostics';
import { warehouseDefaultsInvariants } from './warehouseDefaultsInvariants';
import { warehouseDefaultsPolicy } from './warehouseDefaultsPolicy';
import type {
  LocationRole,
  WarehouseDefaultInvalidReason,
  WarehouseDefaultLocationState,
  WarehouseRootLocationState
} from './warehouseDefaultsPolicy.contract';

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

function mapInvalidReasonToInvariant(
  reason: WarehouseDefaultInvalidReason
): Exclude<WarehouseDefaultsRoleEvaluation['invariant'], null> {
  if (reason === 'type_mismatch') return 'default_location_type_valid';
  if (reason === 'sellable_flag') return 'default_location_sellable_flag_valid';
  return 'default_location_state_valid';
}

function buildRepairBehavior(role: LocationRole, reason: WarehouseDefaultInvalidReason | null) {
  const contractDecision = warehouseDefaultsPolicy.repair.getRepairDecision(reason);
  if (reason === 'missing_location') {
    return {
      requiresMappingDeletion: false,
      shouldRepair: false,
      shouldProvisionLocation: true,
      blocksValidation: warehouseDefaultsPolicy.roles.isRequiredRole(role)
    };
  }
  return {
    requiresMappingDeletion: contractDecision.requiresMappingDeletion,
    shouldRepair: contractDecision.shouldRepair,
    shouldProvisionLocation: contractDecision.requiresMappingDeletion,
    blocksValidation: Boolean(reason)
  };
}

function buildRoleFailure(params: {
  tenantId: string;
  warehouseId: string;
  role: LocationRole;
  invalidReason: WarehouseDefaultInvalidReason;
  defaultLocationId: string | null;
  mappingId: string | null;
  existingDefault: WarehouseDefaultLocationState | null | undefined;
}): WarehouseDefaultsInvariantFailure {
  const { tenantId, warehouseId, role, invalidReason, defaultLocationId, mappingId, existingDefault } = params;
  return {
    invariant: mapInvalidReasonToInvariant(invalidReason),
    errorCode: 'WAREHOUSE_DEFAULT_INVALID',
    repairBehavior: buildRepairBehavior(role, invalidReason),
    role,
    reason: invalidReason,
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
  const invalidReason = warehouseDefaultsPolicy.defaults.detectInvalidReason({
    tenantId,
    warehouseId,
    role,
    existingDefault
  });
  return {
    role,
    defaultLocationId: context?.defaultLocationId ?? null,
    mappingId: context?.mappingId ?? null,
    existingDefault,
    invalidReason,
    invariant: invalidReason ? mapInvalidReasonToInvariant(invalidReason) : null,
    repairBehavior: buildRepairBehavior(role, invalidReason)
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
      warehouseDefaultsPolicy.roles.all.map((role) => [
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
          repairBehavior: {
            requiresMappingDeletion: false,
            shouldRepair: false,
            shouldProvisionLocation: false,
            blocksValidation: true
          },
          invalidMessage: warehouseDefaultsPolicy.topology.formatWarehouseRootInvalidMessage(context.warehouseRoot)
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
      for (const role of warehouseDefaultsPolicy.roles.all) {
        const evaluation = roleEvaluations[role];
        if (!evaluation.invalidReason) continue;
        failures.push(
          buildRoleFailure({
            tenantId: context.tenantId,
            warehouseId: context.warehouseId,
            role,
            invalidReason: evaluation.invalidReason,
            defaultLocationId: evaluation.defaultLocationId,
            mappingId: evaluation.mappingId,
            existingDefault: evaluation.existingDefault
          })
        );
      }
    }

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
