import { apiGet } from '../../../api/http'
import type { DashboardOverview, DashboardSignalSection } from '../../../api/types'

export type DashboardSignalParams = {
  warehouseId?: string
  windowDays?: number
  forceRefresh?: boolean
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function buildParams(params: DashboardSignalParams = {}) {
  const sanitizedWarehouseId =
    typeof params.warehouseId === 'string' && isUuid(params.warehouseId.trim())
      ? params.warehouseId.trim()
      : undefined
  const sanitizedWindowDays =
    typeof params.windowDays === 'number' && Number.isFinite(params.windowDays)
      ? Math.min(365, Math.max(7, Math.trunc(params.windowDays)))
      : undefined

  return {
    ...(sanitizedWarehouseId ? { warehouseId: sanitizedWarehouseId } : {}),
    ...(sanitizedWindowDays ? { windowDays: sanitizedWindowDays } : {}),
    ...(params.forceRefresh ? { forceRefresh: true } : {}),
  }
}

export async function getDashboardOverview(params: DashboardSignalParams = {}): Promise<DashboardOverview> {
  const response = await apiGet<{ data?: DashboardOverview } | DashboardOverview>('/api/dashboard/overview', {
    params: buildParams(params),
  })
  if ('data' in response && response.data) return response.data
  return response as DashboardOverview
}

export async function getDashboardSignalSection(
  endpoint:
    | 'inventory-integrity'
    | 'inventory-risk'
    | 'inventory-coverage'
    | 'flow-reliability'
    | 'supply-reliability'
    | 'excess-inventory'
    | 'demand-volatility'
    | 'forecast-accuracy'
    | 'system-readiness'
    | 'performance-metrics',
  params: DashboardSignalParams = {},
): Promise<DashboardSignalSection> {
  const response = await apiGet<{ data?: DashboardSignalSection } | DashboardSignalSection>(
    `/api/dashboard/${endpoint}`,
    { params: buildParams(params) },
  )
  if ('data' in response && response.data) return response.data
  return response as DashboardSignalSection
}
