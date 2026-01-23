export type OnboardingEventPayload = {
  step_name?: string
  step_index?: number
  timestamp: string
  user_role?: string | null
  business_type?: string | null
  path_chosen?: string | null
  skipped?: boolean
  event?: string
  duration_ms?: number
}

export function trackOnboardingEvent(event: string, payload: OnboardingEventPayload) {
  const envelope = {
    event,
    ...payload,
  }
  // TODO: wire into centralized analytics.
  console.log('[analytics]', envelope)
}
