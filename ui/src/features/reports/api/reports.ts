import { apiGet } from '../../../api/http'
import type { 
  InventoryValuationRow, 
  InventoryValuationSummary,
  CostVarianceRow,
  ReceiptCostAnalysisRow 
} from '../types'

// Inventory Valuation Report
export async function getInventoryValuation(params?: {
  locationId?: string
  itemType?: string
  includeZeroQty?: boolean
  limit?: number
  offset?: number
}): Promise<{ 
  data: InventoryValuationRow[]
  summary: InventoryValuationSummary
}> {
  const searchParams = new URLSearchParams()
  if (params?.locationId) searchParams.append('locationId', params.locationId)
  if (params?.itemType) searchParams.append('itemType', params.itemType)
  if (params?.includeZeroQty) searchParams.append('includeZeroQty', 'true')
  if (params?.limit) searchParams.append('limit', String(params.limit))
  if (params?.offset) searchParams.append('offset', String(params.offset))
  
  return apiGet<{ 
    data: InventoryValuationRow[]
    summary: InventoryValuationSummary
  }>(`/reports/inventory-valuation?${searchParams.toString()}`)
}

// Cost Variance Report
export async function getCostVariance(params?: {
  minVariancePercent?: number
  itemType?: string
  limit?: number
  offset?: number
}): Promise<{ data: CostVarianceRow[] }> {
  const searchParams = new URLSearchParams()
  if (params?.minVariancePercent) searchParams.append('minVariancePercent', String(params.minVariancePercent))
  if (params?.itemType) searchParams.append('itemType', params.itemType)
  if (params?.limit) searchParams.append('limit', String(params.limit))
  if (params?.offset) searchParams.append('offset', String(params.offset))
  
  return apiGet<{ data: CostVarianceRow[] }>(
    `/reports/cost-variance?${searchParams.toString()}`
  )
}

// Receipt Cost Analysis
export async function getReceiptCostAnalysis(params?: {
  startDate?: string
  endDate?: string
  vendorId?: string
  minVariancePercent?: number
  limit?: number
  offset?: number
}): Promise<{ data: ReceiptCostAnalysisRow[] }> {
  const searchParams = new URLSearchParams()
  if (params?.startDate) searchParams.append('startDate', params.startDate)
  if (params?.endDate) searchParams.append('endDate', params.endDate)
  if (params?.vendorId) searchParams.append('vendorId', params.vendorId)
  if (params?.minVariancePercent) searchParams.append('minVariancePercent', String(params.minVariancePercent))
  if (params?.limit) searchParams.append('limit', String(params.limit))
  if (params?.offset) searchParams.append('offset', String(params.offset))
  
  return apiGet<{ data: ReceiptCostAnalysisRow[] }>(
    `/reports/receipt-cost-analysis?${searchParams.toString()}`
  )
}
