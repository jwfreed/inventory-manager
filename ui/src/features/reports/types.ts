// Inventory Valuation Report Types
export type InventoryValuationRow = {
  itemId: string
  itemSku: string
  itemName: string
  locationId: string
  locationCode: string
  locationName: string
  uom: string
  quantityOnHand: number
  averageCost: number | null
  standardCost: number | null
  extendedValue: number | null
}

export type InventoryValuationSummary = {
  totalItems: number
  totalQuantity: number
  totalValue: number
  totalValuedItems: number
  totalUnvaluedItems: number
}

// Cost Variance Report Types
export type CostVarianceRow = {
  itemId: string
  itemSku: string
  itemName: string
  standardCost: number | null
  averageCost: number | null
  variance: number | null
  variancePercent: number | null
  quantityOnHand: number
}

// Receipt Cost Analysis Types
export type ReceiptCostAnalysisRow = {
  receiptId: string
  receiptDate: string
  poNumber: string
  vendorCode: string
  vendorName: string
  itemId: string
  itemSku: string
  itemName: string
  quantityReceived: number
  uom: string
  expectedUnitCost: number | null
  actualUnitCost: number | null
  variance: number | null
  variancePercent: number | null
  extendedVariance: number | null
}
