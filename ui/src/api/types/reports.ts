// ATP (Available to Promise) Types
export type AtpResult = {
  itemId: string
  locationId: string
  uom: string
  onHand: number
  reserved: number
  availableToPromise: number
}

// Supplier Scorecard Types
export type SupplierScorecard = {
  vendorId: string
  vendorCode: string
  vendorName: string
  
  // PO Metrics
  totalPurchaseOrders: number
  totalPoLines: number
  
  // Delivery Metrics
  totalReceipts: number
  onTimeReceipts: number
  lateReceipts: number
  onTimeDeliveryRate: number
  averageDaysLate: number | null
  
  // Quality Metrics
  totalQcEvents: number
  acceptedQuantity: number
  rejectedQuantity: number
  heldQuantity: number
  totalNcrs: number
  openNcrs: number
  closedNcrs: number
  qualityRate: number
  
  // Disposition Metrics
  returnToVendorCount: number
  scrapCount: number
  reworkCount: number
  useAsIsCount: number
}

// LPN Types
export type LpnStatus = 'active' | 'consumed' | 'shipped' | 'damaged' | 'quarantine' | 'expired'

export type LicensePlate = {
  id: string
  tenantId: string
  lpn: string
  status: LpnStatus
  itemId: string
  lotId: string | null
  locationId: string
  parentLpnId: string | null
  quantity: number
  uom: string
  containerType: string | null
  receivedAt: string | null
  expirationDate: string | null
  purchaseOrderReceiptId: string | null
  productionDate: string | null
  notes: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  
  // Joined fields
  itemSku?: string
  itemName?: string
  locationCode?: string
  locationName?: string
  lotCode?: string
}
