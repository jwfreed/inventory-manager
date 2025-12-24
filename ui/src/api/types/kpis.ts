export type FulfillmentFillRate = {
  metricName: string
  shippedQty: number
  requestedQty: number
  fillRate: number | null
  window: { from: string | null; to: string | null }
  assumptions: string[]
}

export type KpiSnapshot = {
  id?: string
  kpi_name: string
  value: number | string | null
  unit?: string | null
  computed_at: string
  dimensions?: Record<string, unknown> | null
  kpi_run_id?: string | null
}

export type KpiRun = {
  id?: string
  status: string
  started_at?: string | null
  finished_at?: string | null
  window_start?: string | null
  window_end?: string | null
  as_of?: string | null
  notes?: string | null
}
