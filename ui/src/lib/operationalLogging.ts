import type { ApiError } from '@api/types'

function extractOperationalErrorCode(err: unknown) {
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

function extractOperationalErrorMessage(err: unknown) {
  if (!err) return 'Unknown operational error'
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  const apiErr = err as ApiError
  if (typeof apiErr?.message === 'string') return apiErr.message
  return 'Unknown operational error'
}

export function logOperationalMutationFailure(
  feature: string,
  action: string,
  error: unknown,
  context?: Record<string, unknown>,
) {
  if (import.meta.env.MODE === 'test') return
  console.error('inventory-manager.operational-mutation-failure', {
    feature,
    action,
    status: (error as ApiError | undefined)?.status ?? null,
    code: extractOperationalErrorCode(error),
    message: extractOperationalErrorMessage(error),
    context: context ?? null,
  })
}
