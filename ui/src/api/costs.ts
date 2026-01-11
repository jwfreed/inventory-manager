import { apiGet, apiPost } from './http'
import type { ComponentCostSnapshot } from './types/costs'

export type CostHistoryRecord = {
  id: string
  costType: 'standard' | 'rolled' | 'avg'
  oldValue: number | null
  newValue: number
  calculatedAt: string
  calculatedBy: string | null
  bomVersionId: string | null
  bomCode: string | null
  versionNumber: number | null
  componentSnapshot: ComponentCostSnapshot[] | null
}

export type CostHistoryResponse = {
  itemId: string
  itemSku: string
  itemName: string
  itemType: string
  isStale: boolean
  recordCount: number
  history: CostHistoryRecord[]
}

export type RollCostResponse = {
  itemId: string
  itemSku: string
  itemName: string
  rolledCost: number
  bomVersionId: string
  message: string
}

export type CostPreviewComponent = {
  itemId: string
  sku: string
  name: string
  quantityPer: number
  uom: string
  unitCost: number
  scrapFactor: number
  extendedCost: number
}

export type CostPreviewResponse = {
  bomVersionId: string
  bomCode: string
  outputItemId: string
  outputItemSku: string
  outputItemName: string
  totalCost: number
  componentCount: number
  components: CostPreviewComponent[]
}

export async function rollItemCost(itemId: string): Promise<RollCostResponse> {
  return apiPost<RollCostResponse>(`/api/items/${itemId}/roll-cost`)
}

export async function previewBomCost(bomVersionId: string): Promise<CostPreviewResponse> {
  return apiPost<CostPreviewResponse>(`/api/boms/${bomVersionId}/cost-preview`)
}

export async function getItemCostHistory(
  itemId: string,
  params?: { limit?: number; costType?: 'standard' | 'rolled' | 'avg' }
): Promise<CostHistoryResponse> {
  const searchParams = new URLSearchParams()
  if (params?.limit) searchParams.set('limit', params.limit.toString())
  if (params?.costType) searchParams.set('costType', params.costType)
  
  const queryString = searchParams.toString()
  const path = queryString ? `/api/items/${itemId}/cost-history?${queryString}` : `/api/items/${itemId}/cost-history`
  
  return apiGet<CostHistoryResponse>(path)
}

export async function batchRollCosts(itemIds?: string[]): Promise<{
  message: string
  processedCount: number
  successCount: number
  failureCount: number
  results: Array<{
    itemId: string
    success: boolean
    rolledCost?: number
    error?: string
  }>
}> {
  return apiPost('/api/items/roll-costs', itemIds ? { itemIds } : undefined)
}
