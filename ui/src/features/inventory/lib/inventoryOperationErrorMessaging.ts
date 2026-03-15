import type { ApiError } from '@api/types'

const TRANSFER_ERROR_MESSAGES: Record<string, string> = {
  INSUFFICIENT_STOCK:
    'Insufficient stock is available at the source location. Reduce the quantity or replenish stock before posting the transfer.',
  WAREHOUSE_SCOPE_MISMATCH:
    'The selected source and destination locations do not align to one warehouse scope. Review the locations and retry.',
  IDEMPOTENCY_REQUEST_IN_PROGRESS:
    'This transfer request is already in progress. Wait for the existing request to finish before retrying.',
  IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS:
    'The transfer request conflicted with an existing idempotency key. Refresh the page and retry once.',
  INV_TRANSFER_IDEMPOTENCY_CONFLICT:
    'A previous transfer request used the same idempotency key with different details. Refresh the page before retrying.',
  INV_TRANSFER_IDEMPOTENCY_INCOMPLETE:
    'The transfer request did not complete cleanly. Refresh the page and verify the movement ledger before retrying.',
  NEGATIVE_OVERRIDE_NOT_ALLOWED:
    'Negative inventory overrides are intentionally unavailable from the transfer screen.',
  NEGATIVE_OVERRIDE_REQUIRES_REASON:
    'A negative override reason is required, but overrides are not exposed from this transfer screen.',
}

function extractFieldErrors(details: unknown) {
  if (!details || typeof details !== 'object') return null
  const error = details as {
    error?: {
      fieldErrors?: Record<string, string[]>
    }
  }
  if (!error.error?.fieldErrors) return null
  const messages = Object.entries(error.error.fieldErrors).flatMap(([field, errors]) =>
    (errors ?? []).map((message) => `${field}: ${message}`),
  )
  return messages.length ? messages.join(' ') : null
}

function extractErrorCode(err: unknown) {
  if (!err || typeof err !== 'object') return null
  const apiErr = err as ApiError
  if (apiErr.details && typeof apiErr.details === 'object') {
    const details = apiErr.details as {
      code?: unknown
      error?: { code?: unknown }
    }
    if (typeof details.error?.code === 'string') return details.error.code
    if (typeof details.code === 'string') return details.code
  }
  if (typeof apiErr.message === 'string' && /^[A-Z0-9_]+$/.test(apiErr.message)) {
    return apiErr.message
  }
  return null
}

export function formatInventoryOperationError(err: unknown, fallback: string) {
  if (!err) return fallback
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  const apiErr = err as ApiError
  const fieldErrors = extractFieldErrors(apiErr.details)
  if (fieldErrors) return fieldErrors
  if (typeof apiErr?.message === 'string') return apiErr.message
  return fallback
}

export function formatTransferOperationError(err: unknown, fallback: string) {
  const code = extractErrorCode(err)
  if (code && TRANSFER_ERROR_MESSAGES[code]) {
    return TRANSFER_ERROR_MESSAGES[code]
  }
  return formatInventoryOperationError(err, fallback)
}
