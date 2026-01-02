import { apiGet, apiPost } from './http'
import type { AtpResult, SupplierScorecard, LicensePlate } from './types'

// ATP API
export async function getAtp(params?: {
  itemId?: string
  locationId?: string
  limit?: number
  offset?: number
}): Promise<{ data: AtpResult[] }> {
  const searchParams = new URLSearchParams()
  if (params?.itemId) searchParams.append('itemId', params.itemId)
  if (params?.locationId) searchParams.append('locationId', params.locationId)
  if (params?.limit) searchParams.append('limit', String(params.limit))
  if (params?.offset) searchParams.append('offset', String(params.offset))
  
  return apiGet<{ data: AtpResult[] }>(`/atp?${searchParams.toString()}`)
}

export async function getAtpDetail(
  itemId: string,
  locationId: string,
  uom?: string
): Promise<{ data: AtpResult }> {
  const searchParams = new URLSearchParams({ itemId, locationId })
  if (uom) searchParams.append('uom', uom)
  
  return apiGet<{ data: AtpResult }>(`/atp/detail?${searchParams.toString()}`)
}

export async function checkAtpSufficiency(data: {
  itemId: string
  locationId: string
  uom: string
  quantity: number
}): Promise<{ data: { sufficient: boolean; atp: number; requested: number } }> {
  return apiPost<{ data: { sufficient: boolean; atp: number; requested: number } }>(
    '/atp/check',
    data
  )
}

// Supplier Scorecard API
export async function getSupplierScorecards(params?: {
  vendorId?: string
  startDate?: string
  endDate?: string
  limit?: number
  offset?: number
}): Promise<{ data: SupplierScorecard[] }> {
  const searchParams = new URLSearchParams()
  if (params?.vendorId) searchParams.append('vendorId', params.vendorId)
  if (params?.startDate) searchParams.append('startDate', params.startDate)
  if (params?.endDate) searchParams.append('endDate', params.endDate)
  if (params?.limit) searchParams.append('limit', String(params.limit))
  if (params?.offset) searchParams.append('offset', String(params.offset))
  
  return apiGet<{ data: SupplierScorecard[] }>(
    `/supplier-scorecards?${searchParams.toString()}`
  )
}

export async function getSupplierScorecard(
  vendorId: string,
  params?: { startDate?: string; endDate?: string }
): Promise<{ data: SupplierScorecard }> {
  const searchParams = new URLSearchParams()
  if (params?.startDate) searchParams.append('startDate', params.startDate)
  if (params?.endDate) searchParams.append('endDate', params.endDate)
  
  return apiGet<{ data: SupplierScorecard }>(
    `/supplier-scorecards/${vendorId}?${searchParams.toString()}`
  )
}

export async function getTopSuppliersByDelivery(
  limit?: number
): Promise<{ data: SupplierScorecard[] }> {
  const searchParams = limit ? `?limit=${limit}` : ''
  return apiGet<{ data: SupplierScorecard[] }>(
    `/supplier-scorecards/rankings/delivery${searchParams}`
  )
}

export async function getTopSuppliersByQuality(
  limit?: number
): Promise<{ data: SupplierScorecard[] }> {
  const searchParams = limit ? `?limit=${limit}` : ''
  return apiGet<{ data: SupplierScorecard[] }>(
    `/supplier-scorecards/rankings/quality${searchParams}`
  )
}

export async function getSuppliersWithQualityIssues(
  minRejectionRate?: number
): Promise<{ data: SupplierScorecard[] }> {
  const searchParams = minRejectionRate ? `?minRejectionRate=${minRejectionRate}` : ''
  return apiGet<{ data: SupplierScorecard[] }>(
    `/supplier-scorecards/issues/quality${searchParams}`
  )
}

// LPN API (placeholder - routes to be implemented)
export async function listLicensePlates(params?: {
  itemId?: string
  locationId?: string
  lotId?: string
  status?: string
  search?: string
  limit?: number
  offset?: number
}): Promise<{ data: LicensePlate[] }> {
  const searchParams = new URLSearchParams()
  if (params?.itemId) searchParams.append('itemId', params.itemId)
  if (params?.locationId) searchParams.append('locationId', params.locationId)
  if (params?.lotId) searchParams.append('lotId', params.lotId)
  if (params?.status) searchParams.append('status', params.status)
  if (params?.search) searchParams.append('search', params.search)
  if (params?.limit) searchParams.append('limit', String(params.limit))
  if (params?.offset) searchParams.append('offset', String(params.offset))
  
  return apiGet<{ data: LicensePlate[] }>(`/lpns?${searchParams.toString()}`)
}

export async function getLicensePlate(id: string): Promise<{ data: LicensePlate }> {
  return apiGet<{ data: LicensePlate }>(`/lpns/${id}`)
}
