export const WAREHOUSE_DEFAULTS_EVENT = {
  ORPHAN_ROOTS_DETECTED: 'WAREHOUSE_DEFAULT_ORPHAN_WAREHOUSE_ROOTS_DETECTED',
  ORPHAN_ROOTS_REPAIRING: 'WAREHOUSE_DEFAULT_ORPHAN_ROOTS_REPAIRING',
  ORPHAN_ROOTS_REPAIRED: 'WAREHOUSE_DEFAULT_ORPHAN_ROOTS_REPAIRED',
  ORPHAN_ROOTS_DETECTION_FAILED: 'WAREHOUSE_DEFAULT_ORPHAN_ROOTS_DETECTION_FAILED',
  DEFAULT_REPAIRING: 'WAREHOUSE_DEFAULT_REPAIRING',
  DEFAULT_REPAIRED: 'WAREHOUSE_DEFAULT_REPAIRED'
} as const;

export type WarehouseDefaultsEventName =
  (typeof WAREHOUSE_DEFAULTS_EVENT)[keyof typeof WAREHOUSE_DEFAULTS_EVENT];

type LocationRole = 'SELLABLE' | 'QA' | 'HOLD' | 'REJECT' | 'SCRAP';

export type WarehouseDefaultValidationSnapshot = {
  role: LocationRole | null;
  warehouse_id: string | null;
  parent_location_id: string | null;
  type: string | null;
  is_sellable: boolean | null;
};

export type WarehouseDefaultRepairStartPayload = {
  tenantId: string;
  warehouseId: string;
  role: LocationRole;
  defaultLocationId: string | null;
  mappingId: string | null;
  reason: string;
  expected: WarehouseDefaultValidationSnapshot;
  actual: WarehouseDefaultValidationSnapshot;
};

export type WarehouseDefaultRepairEndPayload = WarehouseDefaultRepairStartPayload & {
  repaired: {
    tenantId: string;
    warehouseId: string;
    role: LocationRole;
    locationId: string | null;
    defaultLocationId: string | null;
    mappingId: string | null;
  };
};

type WarehouseOrphanSummaryPayload = {
  orphanCount: number;
  tenantId: string | null;
  sampleWarehouseIds: string[];
  sampleTenantIds: string[];
};

export type WarehouseOrphanRepairStartPayload = WarehouseOrphanSummaryPayload;

export type WarehouseOrphanRepairEndPayload = WarehouseOrphanSummaryPayload & {
  createdWarehouseRootsCount: number;
  createdWarehouseRootIds: string[];
  reparentedCount: number;
  relinkedWarehouseCount: number;
  skippedRelinkLocalCodeConflictCount: number;
  remainingCount: number;
  remainingSampleWarehouseIds: string[];
  remainingSampleTenantIds: string[];
};

export type WarehouseOrphanDetectionFailedPayload = {
  tenantId: string | null;
  error: {
    code: string | null;
    message: string;
    detail: string | null;
    schema: string | null;
    table: string | null;
    constraint: string | null;
    routine: string | null;
  };
};

export type WarehouseDefaultsEventPayloadMap = {
  [WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRING]: WarehouseDefaultRepairStartPayload;
  [WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRED]: WarehouseDefaultRepairEndPayload;
  [WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_DETECTED]: WarehouseOrphanSummaryPayload;
  [WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRING]: WarehouseOrphanRepairStartPayload;
  [WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRED]: WarehouseOrphanRepairEndPayload;
  [WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_DETECTION_FAILED]: WarehouseOrphanDetectionFailedPayload;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string' && value[key] !== '';
}

function hasNullableString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === null || typeof value[key] === 'string';
}

function hasNumber(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'number' && Number.isFinite(value[key] as number);
}

function hasBoundedStringArray(value: Record<string, unknown>, key: string, limit = 5): boolean {
  const candidate = value[key];
  if (!Array.isArray(candidate) || candidate.length > limit) return false;
  return candidate.every((row) => typeof row === 'string');
}

function hasValidationSnapshot(value: Record<string, unknown>, key: string): boolean {
  const snapshot = value[key];
  if (!isObject(snapshot)) return false;
  return (
    hasNullableString(snapshot, 'role')
    && hasNullableString(snapshot, 'warehouse_id')
    && hasNullableString(snapshot, 'parent_location_id')
    && hasNullableString(snapshot, 'type')
    && (snapshot.is_sellable === null || typeof snapshot.is_sellable === 'boolean')
  );
}

export function isWarehouseDefaultRepairStartPayload(payload: unknown): payload is WarehouseDefaultRepairStartPayload {
  if (!isObject(payload)) return false;
  return (
    hasString(payload, 'tenantId')
    && hasString(payload, 'warehouseId')
    && hasString(payload, 'role')
    && hasNullableString(payload, 'defaultLocationId')
    && hasNullableString(payload, 'mappingId')
    && hasString(payload, 'reason')
    && hasValidationSnapshot(payload, 'expected')
    && hasValidationSnapshot(payload, 'actual')
  );
}

export function isWarehouseDefaultRepairEndPayload(payload: unknown): payload is WarehouseDefaultRepairEndPayload {
  if (!isWarehouseDefaultRepairStartPayload(payload) || !isObject(payload.repaired)) return false;
  return (
    hasString(payload.repaired, 'tenantId')
    && hasString(payload.repaired, 'warehouseId')
    && hasString(payload.repaired, 'role')
    && hasNullableString(payload.repaired, 'locationId')
    && hasNullableString(payload.repaired, 'defaultLocationId')
    && hasNullableString(payload.repaired, 'mappingId')
  );
}

export function isWarehouseOrphanSummaryPayload(payload: unknown): payload is WarehouseOrphanSummaryPayload {
  if (!isObject(payload)) return false;
  return (
    hasNumber(payload, 'orphanCount')
    && (payload.tenantId === null || typeof payload.tenantId === 'string')
    && hasBoundedStringArray(payload, 'sampleWarehouseIds')
    && hasBoundedStringArray(payload, 'sampleTenantIds')
  );
}

export function isWarehouseOrphanRepairEndPayload(payload: unknown): payload is WarehouseOrphanRepairEndPayload {
  if (!isWarehouseOrphanSummaryPayload(payload)) return false;
  return (
    hasNumber(payload, 'createdWarehouseRootsCount')
    && hasBoundedStringArray(payload, 'createdWarehouseRootIds')
    && hasNumber(payload, 'reparentedCount')
    && hasNumber(payload, 'relinkedWarehouseCount')
    && hasNumber(payload, 'skippedRelinkLocalCodeConflictCount')
    && hasNumber(payload, 'remainingCount')
    && hasBoundedStringArray(payload, 'remainingSampleWarehouseIds')
    && hasBoundedStringArray(payload, 'remainingSampleTenantIds')
  );
}

export function isWarehouseOrphanDetectionFailedPayload(payload: unknown): payload is WarehouseOrphanDetectionFailedPayload {
  if (!isObject(payload) || !isObject(payload.error)) return false;
  return (
    (payload.tenantId === null || typeof payload.tenantId === 'string')
    && hasNullableString(payload.error, 'code')
    && hasString(payload.error, 'message')
    && hasNullableString(payload.error, 'detail')
    && hasNullableString(payload.error, 'schema')
    && hasNullableString(payload.error, 'table')
    && hasNullableString(payload.error, 'constraint')
    && hasNullableString(payload.error, 'routine')
  );
}

export function isWarehouseDefaultsEventPayload<T extends WarehouseDefaultsEventName>(
  event: T,
  payload: unknown
): payload is WarehouseDefaultsEventPayloadMap[T] {
  if (event === WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRING) {
    return isWarehouseDefaultRepairStartPayload(payload);
  }
  if (event === WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRED) {
    return isWarehouseDefaultRepairEndPayload(payload);
  }
  if (event === WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRED) {
    return isWarehouseOrphanRepairEndPayload(payload);
  }
  if (event === WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_DETECTION_FAILED) {
    return isWarehouseOrphanDetectionFailedPayload(payload);
  }
  return isWarehouseOrphanSummaryPayload(payload);
}

export function emitWarehouseDefaultsEvent<T extends WarehouseDefaultsEventName>(
  event: T,
  payload: WarehouseDefaultsEventPayloadMap[T],
  logger: (eventName: string, payload: unknown) => void = console.warn
): void {
  if (!isWarehouseDefaultsEventPayload(event, payload)) {
    logger('WAREHOUSE_DEFAULTS_EVENT_PAYLOAD_INVALID', { event });
  }
  logger(event, payload);
}
