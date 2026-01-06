import { apiGet } from '../../../api/http'

export interface ProductionOverviewFilters {
  dateFrom?: string
  dateTo?: string
  itemId?: string
  locationId?: string
  workCenterId?: string
}

export interface ProductionVolumeTrend {
  period: string
  workOrderCount: number
  totalQuantity: number
}

export interface TopBottomSKU {
  itemId: string
  productionFrequency: number
  avgBatchSize: number
  totalProduced: number
  uom: string
}

export interface WIPStatus {
  status: string
  workOrderCount: number
  totalPlanned: number
  totalCompleted: number
}

export interface MaterialConsumed {
  itemId: string
  uom: string
  totalConsumed: number
  workOrderCount: number
  executionCount: number
}

export interface ProductionOverviewData {
  volumeTrend: ProductionVolumeTrend[]
  topBottomSKUs: TopBottomSKU[]
  wipStatus: WIPStatus[]
  materialsConsumed: MaterialConsumed[]
}

export async function getProductionOverview(
  filters: ProductionOverviewFilters = {}
): Promise<ProductionOverviewData> {
  const params: Record<string, string> = {}
  if (filters.dateFrom) params.dateFrom = filters.dateFrom
  if (filters.dateTo) params.dateTo = filters.dateTo
  if (filters.itemId) params.itemId = filters.itemId
  if (filters.locationId) params.locationId = filters.locationId
  if (filters.workCenterId) params.workCenterId = filters.workCenterId

  return apiGet<ProductionOverviewData>('/production-overview', { params })
}

export async function getProductionVolumeTrend(
  filters: ProductionOverviewFilters = {}
): Promise<ProductionVolumeTrend[]> {
  const params: Record<string, string> = {}
  if (filters.dateFrom) params.dateFrom = filters.dateFrom
  if (filters.dateTo) params.dateTo = filters.dateTo
  if (filters.itemId) params.itemId = filters.itemId
  if (filters.locationId) params.locationId = filters.locationId

  const response = await apiGet<{ data: ProductionVolumeTrend[] }>(
    '/production-overview/volume-trend',
    { params }
  )
  return response.data
}

export async function getTopBottomSKUs(filters: ProductionOverviewFilters = {}): Promise<TopBottomSKU[]> {
  const params: Record<string, string> = {}
  if (filters.dateFrom) params.dateFrom = filters.dateFrom
  if (filters.dateTo) params.dateTo = filters.dateTo
  if (filters.itemId) params.itemId = filters.itemId
  if (filters.locationId) params.locationId = filters.locationId

  const response = await apiGet<{ data: TopBottomSKU[] }>('/production-overview/top-bottom-skus', {
    params,
  })
  return response.data
}

export async function getWIPStatusSummary(filters: ProductionOverviewFilters = {}): Promise<WIPStatus[]> {
  const params: Record<string, string> = {}
  if (filters.dateFrom) params.dateFrom = filters.dateFrom
  if (filters.dateTo) params.dateTo = filters.dateTo
  if (filters.itemId) params.itemId = filters.itemId
  if (filters.locationId) params.locationId = filters.locationId

  const response = await apiGet<{ data: WIPStatus[] }>('/production-overview/wip-status', { params })
  return response.data
}

export async function getMaterialsConsumed(
  filters: ProductionOverviewFilters = {}
): Promise<MaterialConsumed[]> {
  const params: Record<string, string> = {}
  if (filters.dateFrom) params.dateFrom = filters.dateFrom
  if (filters.dateTo) params.dateTo = filters.dateTo
  if (filters.itemId) params.itemId = filters.itemId
  if (filters.locationId) params.locationId = filters.locationId

  const response = await apiGet<{ data: MaterialConsumed[] }>(
    '/production-overview/materials-consumed',
    { params }
  )
  return response.data
}
