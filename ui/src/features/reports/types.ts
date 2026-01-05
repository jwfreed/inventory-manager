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
