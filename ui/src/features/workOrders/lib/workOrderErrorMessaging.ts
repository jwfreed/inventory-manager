import type { ApiError } from '@api/types'

const LIFECYCLE_ERROR_MESSAGES: Record<string, string> = {
  WO_RESERVATION_SHORTAGE:
    'Reservations are short for one or more components. Replenish stock or resolve shortages before setting the work order ready.',
  WO_CLOSE_DRAFT_POSTINGS_EXIST:
    'Draft issue or completion postings still exist. Post or discard the draft postings before closing the work order.',
  WO_CLOSE_INCOMPLETE_PROGRESS:
    'Production is still incomplete. Finish or reconcile the remaining work before closing the work order.',
  WO_WIP_INTEGRITY_FAILED:
    'WIP integrity checks failed. Review recent issue and production postings before closing the work order.',
  WO_INVALID_STATUS_TRANSITION:
    'This lifecycle action is no longer valid for the current work order state. Refresh the page and retry from an allowed status.',
}

function extractApiErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const apiErr = err as ApiError
  const details = apiErr.details

  if (details && typeof details === 'object') {
    const detailRecord = details as {
      code?: unknown
      error?: { code?: unknown }
    }
    if (typeof detailRecord.error?.code === 'string') return detailRecord.error.code
    if (typeof detailRecord.code === 'string') return detailRecord.code
  }

  if (typeof apiErr.message === 'string' && /^WO_[A-Z0-9_]+$/.test(apiErr.message)) {
    return apiErr.message
  }

  return null
}

export function formatWorkOrderError(err: unknown, fallback: string) {
  if (!err) return fallback
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  const apiErr = err as ApiError
  if (typeof apiErr?.message === 'string') return apiErr.message
  return fallback
}

export function formatWorkOrderLifecycleError(err: unknown, fallback: string) {
  const code = extractApiErrorCode(err)
  if (code && LIFECYCLE_ERROR_MESSAGES[code]) {
    return LIFECYCLE_ERROR_MESSAGES[code]
  }
  return formatWorkOrderError(err, fallback)
}
