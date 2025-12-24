import type { InventorySnapshotRow } from './inventory'

export type ReplenishmentRecommendation = {
  policyId: string
  itemId: string
  locationId: string
  uom: string
  policyType: string
  inputs: {
    leadTimeDays: number | null
    reorderPointQty: number | null
    orderUpToLevelQty: number | null
    orderQuantityQty: number | null
    minOrderQty: number | null
    maxOrderQty: number | null
  }
  inventory: InventorySnapshotRow
  recommendation: {
    reorderNeeded: boolean
    recommendedOrderQty: number
    recommendedOrderDate: string | null
  }
  assumptions: string[]
}
