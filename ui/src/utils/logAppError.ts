export type AppErrorPayload = {
  errorId: string
  name?: string
  message?: string
  stack?: string
  componentStack?: string
  url: string
  userAgent?: string
  timestamp: string
}

export function logAppError(payload: AppErrorPayload) {
  // TODO: wire into centralized logging (e.g. Sentry).
  // Keep payload free of PII or app state.
  console.error('[app-error]', payload)
}
