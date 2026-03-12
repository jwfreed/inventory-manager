import { apiGet } from '../../../api/http'
import type { DashboardOverview, DashboardSignalSection } from '../../../api/types'
import type { ApiError } from '../../../api/types'

export type DashboardSignalParams = {
  warehouseId?: string
  windowDays?: number
  forceRefresh?: boolean
}

function buildParams(params: DashboardSignalParams = {}) {
  return {
    ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
    ...(params.windowDays ? { windowDays: params.windowDays } : {}),
    ...(params.forceRefresh ? { forceRefresh: true } : {}),
  }
}

const DASHBOARD_ROUTE_PREFIX = '/dashboard'
const DASHBOARD_ROUTE_FALLBACK_PREFIX = '/api/dashboard'

async function getDashboardPayload<T>(path: string, params: DashboardSignalParams = {}): Promise<T> {
  try {
    return await apiGet<T>(`${DASHBOARD_ROUTE_PREFIX}${path}`, {
      params: buildParams(params),
    })
  } catch (error) {
    const apiError = error as ApiError
    if (apiError.status !== 404) {
      throw error
    }

    return apiGet<T>(`${DASHBOARD_ROUTE_FALLBACK_PREFIX}${path}`, {
      params: buildParams(params),
    })
  }
}

export async function getDashboardOverview(params: DashboardSignalParams = {}): Promise<DashboardOverview> {
  const response = await getDashboardPayload<{ data?: DashboardOverview } | DashboardOverview>(
    '/overview',
    params,
  )
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
  const response = await getDashboardPayload<{ data?: DashboardSignalSection } | DashboardSignalSection>(
    `/${endpoint}`,
    params,
  )
  if ('data' in response && response.data) return response.data
  return response as DashboardSignalSection
}
