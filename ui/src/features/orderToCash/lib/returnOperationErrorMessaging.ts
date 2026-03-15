import type { ApiError } from '../../../api/types'

function extractFieldErrors(details: unknown) {
  if (!details || typeof details !== 'object') return null
  const error = details as {
    error?: {
      fieldErrors?: Record<string, string[]>
      formErrors?: string[]
    }
  }
  const messages = [
    ...(error.error?.formErrors ?? []),
    ...Object.entries(error.error?.fieldErrors ?? {}).flatMap(([field, errors]) =>
      (errors ?? []).map((message) => `${field}: ${message}`),
    ),
  ]
  return messages.length ? messages.join(' ') : null
}

export function formatReturnOperationError(err: unknown, fallback: string) {
  if (!err) return fallback
  const apiErr = err as ApiError
  const fieldErrors = extractFieldErrors(apiErr.details)
  if (fieldErrors) return fieldErrors
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  if (typeof apiErr?.message === 'string') return apiErr.message
  return fallback
}
