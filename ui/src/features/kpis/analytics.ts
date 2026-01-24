export type DashboardAnalyticsPayload = {
  slot_dimension?: string
  from_kpi?: string | null
  to_kpi?: string | null
  missing_dimensions?: string[]
  dimension?: string
  kpi?: string
}

export function trackDashboardEvent(event: string, payload: DashboardAnalyticsPayload = {}) {
  // TODO: wire into centralized analytics.
  console.log('[analytics]', { event, ...payload, timestamp: new Date().toISOString() })
}
