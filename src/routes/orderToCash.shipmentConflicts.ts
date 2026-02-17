import type { Response } from 'express';

const SENSITIVE_DETAIL_KEY_PATTERN = /(stack|sql|query|error|exception|trace|driver|pgcode|sqlstate)/i;
const MAX_DETAIL_DEPTH = 5;

function sanitizeDetailsValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return undefined;
  if (depth > MAX_DETAIL_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => sanitizeDetailsValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
    return items;
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_DETAIL_KEY_PATTERN.test(key)) continue;
      const sanitizedNested = sanitizeDetailsValue(nestedValue, depth + 1);
      if (sanitizedNested !== undefined) {
        output[key] = sanitizedNested;
      }
    }
    return output;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

function toDetailsObject(details: unknown): Record<string, unknown> | undefined {
  const sanitized = sanitizeDetailsValue(details);
  if (sanitized === undefined) return undefined;
  if (Array.isArray(sanitized)) return { items: sanitized };
  if (typeof sanitized === 'object' && sanitized !== null) return sanitized as Record<string, unknown>;
  return { value: sanitized };
}

export function jsonConflict(
  res: Response,
  code: string,
  message: string,
  details?: unknown
) {
  const sanitizedDetails = toDetailsObject(details);
  return res.status(409).json({
    error: {
      code,
      message,
      ...(sanitizedDetails ? { details: sanitizedDetails } : {})
    }
  });
}

export function mapTxRetryExhausted(error: any, res: Response): boolean {
  if (error?.code !== 'TX_RETRY_EXHAUSTED') {
    return false;
  }
  jsonConflict(
    res,
    'TX_RETRY_EXHAUSTED',
    'High write contention detected. Please retry.',
    {
      resource: 'inventory',
      retryable: true,
      hint: 'Please retry the request'
    }
  );
  return true;
}

export function handlePostShipmentConflict(error: any, res: Response): boolean {
  if (mapTxRetryExhausted(error, res)) {
    return true;
  }
  if (error?.code === 'INSUFFICIENT_AVAILABLE_WITH_ALLOWANCE') {
    jsonConflict(
      res,
      'INSUFFICIENT_AVAILABLE_WITH_ALLOWANCE',
      error?.message ?? 'Insufficient available inventory for shipment',
      error?.details
    );
    return true;
  }
  if (error?.code === 'INSUFFICIENT_STOCK' || error?.message === 'INSUFFICIENT_STOCK') {
    jsonConflict(
      res,
      'INSUFFICIENT_STOCK',
      'Insufficient stock to post shipment.',
      error?.details
    );
    return true;
  }
  if (error?.code === 'NEGATIVE_OVERRIDE_REQUIRES_REASON') {
    jsonConflict(
      res,
      'NEGATIVE_OVERRIDE_REQUIRES_REASON',
      error?.details?.message ?? 'Negative override requires a reason.',
      error?.details
    );
    return true;
  }
  if (error?.message === 'SHIPMENT_CANCELED') {
    jsonConflict(
      res,
      'SHIPMENT_CANCELED',
      'Canceled shipments cannot be posted.'
    );
    return true;
  }
  if (error?.message === 'RESERVATION_INVALID_STATE') {
    jsonConflict(
      res,
      'RESERVATION_INVALID_STATE',
      'Reservation state changed while posting shipment. Please retry.'
    );
    return true;
  }
  return false;
}
