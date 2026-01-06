import { apiGet } from '../../../api/http'
import type { 
  InventoryValuationRow, 
  InventoryValuationSummary,
  CostVarianceRow,
  ReceiptCostAnalysisRow,
  WorkOrderProgressRow,
  MovementTransactionRow,
  InventoryVelocityRow,
  OpenPOAgingRow,
  SalesOrderFillRow,
  ProductionRunFrequencyRow,
  LeadTimeReliabilityRow,
  PriceVarianceTrendRow,
  VendorFillRateRow,
  VendorQualityRateRow
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

// Work Order Progress Report
export async function getWorkOrderProgress(params?: {
  startDate?: string
  endDate?: string
  status?: string
  itemId?: string
  includeCompleted?: boolean
  limit?: number
  offset?: number
}): Promise<{ data: WorkOrderProgressRow[] }> {
  const searchParams = new URLSearchParams()
  if (params?.startDate) searchParams.append('startDate', params.startDate)
  if (params?.endDate) searchParams.append('endDate', params.endDate)
  if (params?.status) searchParams.append('status', params.status)
  if (params?.itemId) searchParams.append('itemId', params.itemId)
  if (params?.includeCompleted) searchParams.append('includeCompleted', 'true')
  if (params?.limit) searchParams.append('limit', String(params.limit))
  if (params?.offset) searchParams.append('offset', String(params.offset))
  
  return apiGet<{ data: WorkOrderProgressRow[] }>(
    `/reports/work-order-progress?${searchParams.toString()}`
  )
}

// Movement Transaction History Report
export async function getMovementTransactions(params?: {
  startDate?: string
  endDate?: string
  itemId?: string
  locationId?: string
  movementType?: string
  limit?: number
  offset?: number
}): Promise<{ data: MovementTransactionRow[] }> {
  const searchParams = new URLSearchParams()
  if (params?.startDate) searchParams.append('startDate', params.startDate)
  if (params?.endDate) searchParams.append('endDate', params.endDate)
  if (params?.itemId) searchParams.append('itemId', params.itemId)
  if (params?.locationId) searchParams.append('locationId', params.locationId)
  if (params?.movementType) searchParams.append('movementType', params.movementType)
  if (params?.limit) searchParams.append('limit', String(params.limit))
  if (params?.offset) searchParams.append('offset', String(params.offset))
  
  return apiGet<{ data: MovementTransactionRow[] }>(
    `/reports/movement-transactions?${searchParams.toString()}`
  )
}

// Inventory Movement Velocity Report
export async function getInventoryVelocity(params: {
  startDate: string
  endDate: string
  itemType?: string
  locationId?: string
  minMovements?: number
  limit?: number
  offset?: number
}): Promise<{ data: InventoryVelocityRow[] }> {
  const searchParams = new URLSearchParams()
  searchParams.append('startDate', params.startDate)
  searchParams.append('endDate', params.endDate)
  if (params.itemType) searchParams.append('itemType', params.itemType)
  if (params.locationId) searchParams.append('locationId', params.locationId)
  if (params.minMovements) searchParams.append('minMovements', String(params.minMovements))
  if (params.limit) searchParams.append('limit', String(params.limit))
  if (params.offset) searchParams.append('offset', String(params.offset))
  
  return apiGet<{ data: InventoryVelocityRow[] }>(
    `/reports/inventory-velocity?${searchParams.toString()}`
  )
}

// Open PO Aging Report
export async function getOpenPOAging(params?: {
  vendorId?: string
  minDaysOpen?: number
  includeFullyReceived?: boolean
  limit?: number
  offset?: number
}): Promise<{ data: OpenPOAgingRow[] }> {
  const searchParams = new URLSearchParams()
  if (params?.vendorId) searchParams.append('vendorId', params.vendorId)
  if (params?.minDaysOpen) searchParams.append('minDaysOpen', String(params.minDaysOpen))
  if (params?.includeFullyReceived) searchParams.append('includeFullyReceived', 'true')
  if (params?.limit) searchParams.append('limit', String(params.limit))
  if (params?.offset) searchParams.append('offset', String(params.offset))
  
  return apiGet<{ data: OpenPOAgingRow[] }>(
    `/reports/open-po-aging?${searchParams.toString()}`
  )
}

// Sales Order Fill Performance Report
export async function getSalesOrderFillPerformance(params?: {
  startDate?: string
  endDate?: string
  customerId?: string
  includeFullyShipped?: boolean
  onlyLate?: boolean
  limit?: number
  offset?: number
}): Promise<{ data: SalesOrderFillRow[] }> {
  const searchParams = new URLSearchParams()
  if (params?.startDate) searchParams.append('startDate', params.startDate)
  if (params?.endDate) searchParams.append('endDate', params.endDate)
  if (params?.customerId) searchParams.append('customerId', params.customerId)
  if (params?.includeFullyShipped) searchParams.append('includeFullyShipped', 'true')
  if (params?.onlyLate) searchParams.append('onlyLate', 'true')
  if (params?.limit) searchParams.append('limit', String(params.limit))
  if (params?.offset) searchParams.append('offset', String(params.offset))
  
  return apiGet<{ data: SalesOrderFillRow[] }>(
    `/reports/sales-order-fill?${searchParams.toString()}`
  )
}

// Production Run Frequency Report
export async function getProductionRunFrequency(params: {
  startDate: string
  endDate: string
  itemType?: string
  itemId?: string
  minRuns?: number
  limit?: number
  offset?: number
}): Promise<{ data: ProductionRunFrequencyRow[] }> {
  const searchParams = new URLSearchParams()
  searchParams.append('startDate', params.startDate)
  searchParams.append('endDate', params.endDate)
  if (params.itemType) searchParams.append('itemType', params.itemType)
  if (params.itemId) searchParams.append('itemId', params.itemId)
  if (params.minRuns) searchParams.append('minRuns', String(params.minRuns))
  if (params.limit) searchParams.append('limit', String(params.limit))
  if (params.offset) searchParams.append('offset', String(params.offset))
  
  return apiGet<{ data: ProductionRunFrequencyRow[] }>(
    `/reports/production-run-frequency?${searchParams.toString()}`
  )
}

// Supplier Performance APIs

// Lead Time Reliability
export async function getLeadTimeReliability(params: {
  startDate: string
  endDate: string
  vendorId?: string
  limit?: number
  offset?: number
}): Promise<{ data: LeadTimeReliabilityRow[] }> {
  const searchParams = new URLSearchParams()
  searchParams.append('startDate', params.startDate)
  searchParams.append('endDate', params.endDate)
  if (params.vendorId) searchParams.append('vendorId', params.vendorId)
  if (params.limit) searchParams.append('limit', String(params.limit))
  if (params.offset) searchParams.append('offset', String(params.offset))
  
  return apiGet<{ data: LeadTimeReliabilityRow[] }>(
    `/supplier-performance/lead-time-reliability?${searchParams.toString()}`
  )
}

// Price Variance Trends
export async function getPriceVarianceTrends(params: {
  startDate: string
  endDate: string
  vendorId?: string
  limit?: number
}): Promise<{ data: PriceVarianceTrendRow[] }> {
  const searchParams = new URLSearchParams()
  searchParams.append('startDate', params.startDate)
  searchParams.append('endDate', params.endDate)
  if (params.vendorId) searchParams.append('vendorId', params.vendorId)
  if (params.limit) searchParams.append('limit', String(params.limit))
  
  return apiGet<{ data: PriceVarianceTrendRow[] }>(
    `/supplier-performance/price-variance-trends?${searchParams.toString()}`
  )
}

// Vendor Fill Rate
export async function getVendorFillRate(params: {
  startDate: string
  endDate: string
  vendorId?: string
  limit?: number
  offset?: number
}): Promise<{ data: VendorFillRateRow[] }> {
  const searchParams = new URLSearchParams()
  searchParams.append('startDate', params.startDate)
  searchParams.append('endDate', params.endDate)
  if (params.vendorId) searchParams.append('vendorId', params.vendorId)
  if (params.limit) searchParams.append('limit', String(params.limit))
  if (params.offset) searchParams.append('offset', String(params.offset))
  
  return apiGet<{ data: VendorFillRateRow[] }>(
    `/supplier-performance/vendor-fill-rate?${searchParams.toString()}`
  )
}

// Vendor Quality Rate
export async function getVendorQualityRate(params: {
  startDate: string
  endDate: string
  vendorId?: string
  limit?: number
  offset?: number
}): Promise<{ data: VendorQualityRateRow[] }> {
  const searchParams = new URLSearchParams()
  searchParams.append('startDate', params.startDate)
  searchParams.append('endDate', params.endDate)
  if (params.vendorId) searchParams.append('vendorId', params.vendorId)
  if (params.limit) searchParams.append('limit', String(params.limit))
  if (params.offset) searchParams.append('offset', String(params.offset))
  
  return apiGet<{ data: VendorQualityRateRow[] }>(
    `/supplier-performance/quality-rate?${searchParams.toString()}`
  )
}
