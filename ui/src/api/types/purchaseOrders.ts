export type PurchaseOrderLine = {
  id: string
  purchaseOrderId?: string
  lineNumber?: number
  itemId?: string
  itemSku?: string | null
  itemName?: string | null
  uom?: string
  quantityOrdered?: number
  unitCost?: number | null
  unitPrice?: number | null
  currencyCode?: string | null
  exchangeRateToBase?: number | null
  lineAmount?: number | null
  baseAmount?: number | null
  overReceiptTolerancePct?: number | null
  requiresLot?: boolean | null
  requiresSerial?: boolean | null
  requiresQc?: boolean | null
  notes?: string | null
  quantityReceived?: number
  status?: 'open' | 'complete' | 'closed_short' | 'cancelled'
  closedReason?: string | null
  closedNotes?: string | null
  closedAt?: string | null
  closedByUserId?: string | null
  createdAt?: string
}

export type PurchaseOrder = {
  id: string
  poNumber: string
  vendorId: string
  vendorCode?: string | null
  vendorName?: string | null
  status: string
  orderDate?: string
  expectedDate?: string
  shipToLocationId?: string
  shipToLocationCode?: string | null
  shipToLocationName?: string | null
  receivingLocationId?: string | null
  receivingLocationCode?: string | null
  receivingLocationName?: string | null
  vendorReference?: string
  notes?: string
  closeReason?: string | null
  closeNotes?: string | null
  closedAt?: string | null
  closedByUserId?: string | null
  createdAt?: string
  updatedAt?: string
  lines?: PurchaseOrderLine[]
}
