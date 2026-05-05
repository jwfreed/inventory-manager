/**
 * Centralized invariant: tracked inventory must never exist without valid trace data.
 * Enforced across all inventory write paths that create on-hand stock for lot/serial-tracked items.
 */

export const TRACKED_INVENTORY_TRACE_ERROR =
  'Tracked item requires lot/serial data for on-hand import';

export type TraceFieldError = {
  field: 'lotNumber' | 'serialNumber';
  message: string;
};

export type TraceInvariantViolation = {
  traceErrors: TraceFieldError[];
};

/**
 * Assert that a lot/serial-tracked item has the required trace data.
 * Throws an error with `traceErrors` attached if any required field is missing.
 * Safe to call in both validation and apply paths.
 */
export function assertTracedInventoryRequirements(params: {
  requiresLot: boolean;
  requiresSerial: boolean;
  lotNumber: string | null | undefined;
  serialNumber: string | null | undefined;
}): void {
  const errors: TraceFieldError[] = [];

  if (params.requiresLot && !params.lotNumber?.trim()) {
    errors.push({ field: 'lotNumber', message: TRACKED_INVENTORY_TRACE_ERROR });
  }
  if (params.requiresSerial && !params.serialNumber?.trim()) {
    errors.push({ field: 'serialNumber', message: TRACKED_INVENTORY_TRACE_ERROR });
  }

  if (errors.length > 0) {
    const err = new Error(TRACKED_INVENTORY_TRACE_ERROR) as Error & TraceInvariantViolation;
    err.traceErrors = errors;
    throw err;
  }
}
