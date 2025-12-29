export type InventoryAdjustmentLine = {
  id: string
  lineNumber: number
  itemId: string
  itemSku?: string | null
  itemName?: string | null
  locationId: string
  locationCode?: string | null
  locationName?: string | null
  uom: string
  quantityDelta: number
  reasonCode: string
  notes?: string | null
  createdAt?: string
}

export type InventoryAdjustment = {
  id: string
  status: string
  occurredAt: string
  inventoryMovementId?: string | null
  correctedFromAdjustmentId?: string | null
  isCorrected?: boolean
  notes?: string | null
  createdAt?: string
  updatedAt?: string
  lines?: InventoryAdjustmentLine[]
}

export type InventoryAdjustmentSummary = {
  id: string
  status: string
  occurredAt: string
  inventoryMovementId?: string | null
  correctedFromAdjustmentId?: string | null
  isCorrected?: boolean
  notes?: string | null
  createdAt?: string
  updatedAt?: string
  lineCount?: number
  totalsByUom?: Array<{ uom: string; quantityDelta: number }>
}

export type InventoryAdjustmentListResponse = {
  data: InventoryAdjustmentSummary[]
  paging?: { limit: number; offset: number }
}
