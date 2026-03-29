import { WAREHOUSE_DEFAULTS_REPAIR_HINT } from '../../config/warehouseDefaultsStartup';
import type { WarehouseDefaultValidationSnapshot } from '../../observability/warehouseDefaults.events';
import {
  emitWarehouseDefaultsEvent,
  WAREHOUSE_DEFAULTS_EVENT
} from '../../observability/warehouseDefaults.events';
import type {
  LocationRole,
  OrphanIssueDetector,
  OrphanWarehouseRelinkConflict,
  OrphanWarehouseRootIssue,
  WarehouseDefaultInvalidReason
} from './warehouseDefaultsDetection';

export function summarizeOrphanWarehouseRootIssues(issues: OrphanWarehouseRootIssue[], tenantId?: string) {
  const sampleWarehouseIds = Array.from(new Set(issues.map((row) => row.warehouse_id).filter((row): row is string => Boolean(row)))).slice(0, 5);
  const sampleTenantIds = Array.from(new Set(issues.map((row) => row.tenant_id))).slice(0, 5);
  return {
    orphanCount: issues.length,
    tenantId: tenantId ?? null,
    sampleWarehouseIds,
    sampleTenantIds
  };
}

export function buildWarehouseDefaultExpected(role: LocationRole, warehouseId: string): WarehouseDefaultValidationSnapshot {
  return {
    role,
    warehouse_id: warehouseId,
    parent_location_id: warehouseId,
    type: role === 'SCRAP' ? 'scrap' : 'bin',
    is_sellable: role === 'SELLABLE' ? true : null
  };
}

export function buildWarehouseDefaultActual(
  role: LocationRole,
  existingDefault: {
    role: LocationRole;
    parent_location_id: string | null;
    warehouse_id: string;
    type: string;
    is_sellable: boolean;
  } | null | undefined
): WarehouseDefaultValidationSnapshot {
  return {
    role: existingDefault?.role ?? null,
    warehouse_id: existingDefault?.warehouse_id ?? null,
    parent_location_id: existingDefault?.parent_location_id ?? null,
    type: existingDefault?.type ?? null,
    is_sellable: role === 'SELLABLE' ? (existingDefault?.is_sellable ?? null) : null
  };
}

export function warehouseDefaultInvalidError(details: {
  tenantId: string;
  warehouseId: string;
  role: LocationRole | null;
  defaultLocationId: string | null;
  mappingId: string | null;
  reason: WarehouseDefaultInvalidReason;
  expected: WarehouseDefaultValidationSnapshot;
  actual: WarehouseDefaultValidationSnapshot;
}, options: { repairEnabled?: boolean } = {}) {
  const error = new Error('WAREHOUSE_DEFAULT_INVALID') as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  const repairEnabled = options.repairEnabled ?? false;
  error.code = 'WAREHOUSE_DEFAULT_INVALID';
  error.details = repairEnabled ? details : { ...details, hint: WAREHOUSE_DEFAULTS_REPAIR_HINT };
  return error;
}

export function warehouseDefaultInternalDerivedIdWithoutMappingError(details: {
  tenantId: string;
  warehouseId: string;
  role: LocationRole;
  derivedId: string;
}) {
  const error = new Error('WAREHOUSE_DEFAULT_INTERNAL_DERIVED_ID_WITHOUT_MAPPING') as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = 'WAREHOUSE_DEFAULT_INTERNAL_DERIVED_ID_WITHOUT_MAPPING';
  error.details = details;
  return error;
}

export function warehouseOrphanRootsUnresolvedError(details: {
  tenantId: string | null;
  remainingCount: number;
  skippedRelinkLocalCodeConflictCount: number;
  remainingSampleWarehouseIds: string[];
  remainingSampleTenantIds: string[];
  conflicts: OrphanWarehouseRelinkConflict[];
}) {
  const error = new Error('WAREHOUSE_DEFAULT_ORPHAN_ROOTS_UNRESOLVED') as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = 'WAREHOUSE_DEFAULT_ORPHAN_ROOTS_UNRESOLVED';
  error.details = {
    ...details,
    reason: details.conflicts.length > 0 ? 'local_code_conflict' : 'remaining_orphan_roots'
  };
  return error;
}

export function buildOrphanDetectionFailurePayload(tenantId: string | undefined, error: unknown) {
  const candidate = (error ?? {}) as {
    code?: unknown;
    sqlstate?: unknown;
    sqlState?: unknown;
    message?: unknown;
    detail?: unknown;
    schema?: unknown;
    table?: unknown;
    constraint?: unknown;
    routine?: unknown;
  };
  const normalizeNullableString = (value: unknown, maxLength = 500): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxLength);
  };
  const code =
    normalizeNullableString(candidate.code, 64)
    ?? normalizeNullableString(candidate.sqlstate, 64)
    ?? normalizeNullableString(candidate.sqlState, 64);
  const message = normalizeNullableString(candidate.message, 500) ?? 'ORPHAN_ROOTS_DETECTION_FAILED';
  return {
    tenantId: tenantId ?? null,
    error: {
      code,
      message,
      detail: normalizeNullableString(candidate.detail, 500),
      schema: normalizeNullableString(candidate.schema, 128),
      table: normalizeNullableString(candidate.table, 128),
      constraint: normalizeNullableString(candidate.constraint, 128),
      routine: normalizeNullableString(candidate.routine, 128)
    }
  };
}

export async function findOrphanWarehouseRootIssuesBestEffort(
  detector: OrphanIssueDetector,
  tenantId?: string
): Promise<OrphanWarehouseRootIssue[]> {
  try {
    return await detector(tenantId);
  } catch (error) {
    emitWarehouseDefaultsEvent(
      WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_DETECTION_FAILED,
      buildOrphanDetectionFailurePayload(tenantId, error)
    );
    return [];
  }
}
