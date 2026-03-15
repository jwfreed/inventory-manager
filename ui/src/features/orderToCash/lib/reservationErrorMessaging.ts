import type { ApiError } from '../../../api/types'

const RESERVATION_ERROR_MESSAGES: Record<string, string> = {
  NON_SELLABLE_LOCATION:
    'The reservation location is not sellable. Choose a sellable ship location before allocating or fulfilling this reservation.',
  RESERVATION_INVALID_QUANTITY:
    'Enter a positive fulfill quantity before retrying this reservation action.',
  RESERVATION_CONFLICT:
    'The reservation changed concurrently. Refresh the page and retry the action on the latest state.',
  RESERVATION_ALLOCATE_IN_PROGRESS:
    'Reservation allocation is already in progress. Wait for the existing request to finish before retrying.',
  RESERVATION_CANCEL_IN_PROGRESS:
    'Reservation cancel is already in progress. Wait for the existing request to finish before retrying.',
  RESERVATION_FULFILL_IN_PROGRESS:
    'Reservation fulfill is already in progress. Wait for the existing request to finish before retrying.',
  RESERVATION_INVALID_TRANSITION:
    'This reservation action is no longer valid for the current state. Refresh the page and retry from an allowed state.',
}

function extractReservationErrorCode(err: unknown): string | null {
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

export function formatReservationError(err: unknown, fallback: string) {
  const code = extractReservationErrorCode(err)
  if (code && RESERVATION_ERROR_MESSAGES[code]) {
    return RESERVATION_ERROR_MESSAGES[code]
  }
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  const apiErr = err as ApiError
  if (typeof apiErr?.message === 'string') return apiErr.message
  return fallback
}
