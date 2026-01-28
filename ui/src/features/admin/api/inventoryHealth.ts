import { apiGet } from '../../../api/http'
import type { ApiError } from '../../../api/types'

export type InventoryHealthGate = {
  pass: boolean
  reasons: string[]
  thresholds: Record<string, unknown>
}

export type InventoryHealthResult = {
  gate: InventoryHealthGate
  ledgerVsCostLayers: {
    rowCount: number
    rowsWithVariance: number
    variancePct: number
    absQtyVariance: number
    absValueVariance: number
    topOffenders: Array<{
      itemId: string
      itemSku: string | null
      locationId: string
      locationCode: string | null
      uom: string
      ledgerQty: number
      layerQty: number
      varianceQty: number
      varianceValue: number
    }>
  }
  cycleCountVariance: {
    totalLines: number
    linesWithVariance: number
    variancePct: number
    absQtyVariance: number
    topOffenders: Array<{
      itemId: string
      itemSku: string | null
      locationId: string
      locationCode: string | null
      uom: string
      varianceQty: number
      countedAt: string
      cycleCountId: string
    }>
  }
  negativeInventory: {
    count: number
    topOffenders: Array<{
      itemId: string
      itemSku: string | null
      locationId: string
      locationCode: string | null
      uom: string
      onHand: number
    }>
  }
  generatedAt: string
  durationMs: number
}

export async function getInventoryHealth() {
  try {
    const response = await apiGet<{ data: InventoryHealthResult }>('/admin/inventory-health')
    return response.data
  } catch (error) {
    const err = error as ApiError
    const details = err?.details as { data?: InventoryHealthResult } | undefined
    if (err?.status === 409 && details?.data) {
      return details.data
    }
    throw error
  }
}
