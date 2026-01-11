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
  notes?: string | null
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
  receivingLocationId?: string | null
  receivingLocationCode?: string | null
  vendorReference?: string
  notes?: string
  createdAt?: string
  updatedAt?: string
  lines?: PurchaseOrderLine[]
}
