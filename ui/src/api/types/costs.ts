export type CostType = 'standard' | 'rolled' | 'avg'

export type ComponentCostSnapshot = {
  componentItemId: string
  componentSku: string
  componentName: string
  quantityPer: number
  uom: string
  unitCost: number
  extendedCost: number
  scrapFactor?: number
}

export type ItemCostHistory = {
  id: string
  tenantId: string
  itemId: string
  costType: CostType
  oldValue: number | null
  newValue: number
  calculatedAt: string
  calculatedBy: string | null
  bomVersionId: string | null
  componentSnapshot: ComponentCostSnapshot[] | null
  createdAt: string
}

export type CreateItemCostHistory = {
  itemId: string
  costType: CostType
  oldValue: number | null
  newValue: number
  calculatedBy?: string | null
  bomVersionId?: string | null
  componentSnapshot?: ComponentCostSnapshot[] | null
}
