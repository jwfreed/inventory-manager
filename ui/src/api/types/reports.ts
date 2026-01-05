// ATP (Available to Promise) Types
export type AtpResult = {
  itemId: string
  itemSku: string
  itemName: string
  locationId: string
  locationCode: string
  locationName: string
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

// Work Order Progress Report Types
export type WorkOrderProgressRow = {
  workOrderId: string
  workOrderNumber: string
  itemId: string
  itemSku: string
  itemName: string
  status: string
  orderType: string
  quantityPlanned: number
  quantityCompleted: number
  percentComplete: number
  dueDate: string | null
  daysUntilDue: number | null
  isLate: boolean
  createdAt: string
}

// Movement Transaction History Report Types
export type MovementTransactionRow = {
  movementId: string
  movementNumber: string
  movementType: string
  status: string
  lineId: string
  itemId: string
  itemSku: string
  itemName: string
  locationId: string
  locationCode: string
  locationName: string
  quantity: number
  uom: string
  unitCost: number | null
  extendedValue: number | null
  lotNumber: string | null
  referenceType: string | null
  referenceNumber: string | null
  notes: string | null
  createdAt: string
  postedAt: string | null
}

// Inventory Movement Velocity Report Types
export type InventoryVelocityRow = {
  itemId: string
  itemSku: string
  itemName: string
  itemType: string
  totalMovements: number
  quantityIn: number
  quantityOut: number
  netChange: number
  currentOnHand: number
  daysInPeriod: number
  avgDailyMovement: number
  turnoverProxy: number | null
}

// Open PO Aging Report Types
export type OpenPOAgingRow = {
  purchaseOrderId: string
  poNumber: string
  vendorId: string
  vendorCode: string
  vendorName: string
  status: string
  orderDate: string
  promisedDate: string | null
  daysOpen: number
  daysOverdue: number | null
  totalLines: number
  receivedLines: number
  outstandingLines: number
  totalOrdered: number
  totalReceived: number
  fillRate: number
}

// Sales Order Fill Performance Report Types
export type SalesOrderFillRow = {
  salesOrderId: string
  soNumber: string
  customerCode: string | null
  customerName: string | null
  status: string
  orderDate: string
  requestedDate: string | null
  shippedDate: string | null
  daysToShip: number | null
  isLate: boolean
  totalLines: number
  shippedLines: number
  outstandingLines: number
  totalOrdered: number
  totalShipped: number
  fillRate: number
  onTimeShipment: boolean
}

// Production Run Frequency Report Types
export type ProductionRunFrequencyRow = {
  itemId: string
  itemSku: string
  itemName: string
  itemType: string
  totalRuns: number
  totalQuantityProduced: number
  avgBatchSize: number
  minBatchSize: number
  maxBatchSize: number
  lastProductionDate: string | null
  daysSinceLastProduction: number | null
}
