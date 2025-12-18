export type ApiError = {
  status: number
  message: string
  details?: unknown
}

export type ApiResult<T> = {
  data?: T
  error?: ApiError
}

export type Movement = {
  id: string
  movementType: string
  status: string
  occurredAt: string
  postedAt?: string | null
  externalRef?: string | null
  notes?: string | null
  createdAt?: string
  updatedAt?: string
}

export type MovementLine = {
  id: string
  movementId: string
  itemId: string
  itemSku?: string
  itemName?: string
  locationId: string
  locationCode?: string
  locationName?: string
  uom: string
  quantityDelta: number
  reasonCode?: string | null
  lineNotes?: string | null
}

export type MovementListResponse = {
  data: Movement[]
  paging?: { limit: number; offset: number }
}

export type WorkOrder = {
  id: string
  workOrderNumber: string
  status: string
  bomId?: string
  bomVersionId?: string | null
  outputItemId: string
  outputUom: string
  quantityPlanned: number
  quantityCompleted?: number | null
  defaultConsumeLocationId?: string | null
  defaultProduceLocationId?: string | null
  notes?: string | null
}

export type WorkOrderListResponse = {
  data: WorkOrder[]
  paging?: { limit: number; offset: number }
}

export type WorkOrderRequirementLine = {
  lineNumber: number
  componentItemId: string
  uom: string
  quantityRequired: number
  scrapFactor: number | null
}

export type WorkOrderRequirements = {
  workOrderId: string
  outputItemId: string
  bomId: string
  bomVersionId: string
  quantityRequested: number
  requestedUom: string
  lines: WorkOrderRequirementLine[]
}

export type BomVersionComponent = {
  id: string
  bomVersionId: string
  lineNumber: number
  componentItemId: string
  quantityPer: number
  uom: string
  scrapFactor: number | null
  notes: string | null
  createdAt: string
}

export type BomVersion = {
  id: string
  bomId: string
  versionNumber: number
  status: string
  effectiveFrom: string | null
  effectiveTo: string | null
  yieldQuantity: number
  yieldUom: string
  notes: string | null
  createdAt: string
  updatedAt: string
  components: BomVersionComponent[]
}

export type Bom = {
  id: string
  bomCode: string
  outputItemId: string
  defaultUom: string
  active: boolean
  notes: string | null
  createdAt: string
  updatedAt: string
  versions: BomVersion[]
}

export type WorkOrderExecutionSummary = {
  workOrder: {
    id: string
    status: string
    bomId: string
    bomVersionId: string | null
    outputItemId: string
    outputUom: string
    quantityPlanned: number
    quantityCompleted: number
    completedAt?: string | null
  }
  issuedTotals: { componentItemId: string; uom: string; quantityIssued: number }[]
  issuedTotals: {
    componentItemId: string
    componentItemSku?: string
    componentItemName?: string
    uom: string
    quantityIssued: number
  }[]
  completedTotals: {
    outputItemId: string
    outputItemSku?: string
    outputItemName?: string
    uom: string
    quantityCompleted: number
  }[]
  remainingToComplete: number
}

export type WorkOrderIssue = {
  id: string
  workOrderId: string
  status: string
  occurredAt: string
  inventoryMovementId?: string | null
  notes?: string | null
  lines: {
    id: string
    lineNumber: number
    componentItemId: string
    fromLocationId: string
    uom: string
    quantityIssued: number
    notes?: string | null
  }[]
}

export type WorkOrderCompletion = {
  id: string
  workOrderId: string
  status: string
  occurredAt: string
  productionMovementId?: string | null
  notes?: string | null
  lines: {
    id: string
    lineType: string
    itemId: string
    toLocationId: string | null
    uom: string
    quantity: number
    packSize?: number | null
    notes?: string | null
  }[]
}

export type Item = {
  id: string
  sku: string
  name: string
  description?: string | null
  active: boolean
  createdAt?: string
  updatedAt?: string
}

export type ItemInventoryRow = {
  locationId: string
  locationCode?: string
  locationName?: string
  uom: string
  onHand: number
}

export type Location = {
  id: string
  code: string
  name: string
  type: string
  active: boolean
  parentLocationId?: string | null
  path?: string | null
  depth?: number | null
  createdAt?: string
  updatedAt?: string
}

export type LocationInventoryRow = {
  itemId: string
  itemSku?: string
  itemName?: string
  uom: string
  onHand: number
}

export type InventorySnapshotRow = {
  itemId: string
  locationId: string
  uom: string
  onHand: number
  reserved: number
  available: number
  onOrder: number
  inTransit: number
  backordered: number
  inventoryPosition: number
}

export type FulfillmentFillRate = {
  metricName: string
  shippedQty: number
  requestedQty: number
  fillRate: number | null
  window: { from: string | null; to: string | null }
  assumptions: string[]
}

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

export type SalesOrder = {
  id: string
  soNumber: string
  customerId: string
  status: string
  orderDate?: string
  requestedShipDate?: string
  shipFromLocationId?: string
  customerReference?: string
  notes?: string
  createdAt?: string
  updatedAt?: string
  lines?: SalesOrderLine[]
  shipments?: Shipment[]
}

export type SalesOrderLine = {
  id: string
  salesOrderId?: string
  lineNumber?: number
  itemId?: string
  uom?: string
  quantityOrdered?: number
  notes?: string | null
}

export type Reservation = {
  id: string
  status?: string
  demandType?: string
  demandId?: string
  itemId?: string
  locationId?: string
  uom?: string
  quantityReserved?: number
  quantityFulfilled?: number | null
  reservedAt?: string
  releasedAt?: string | null
  releaseReasonCode?: string | null
  notes?: string | null
  createdAt?: string
  updatedAt?: string
}

export type Shipment = {
  id: string
  salesOrderId?: string
  shippedAt?: string
  shipFromLocationId?: string
  inventoryMovementId?: string | null
  externalRef?: string | null
  notes?: string | null
  createdAt?: string
  lines?: ShipmentLine[]
}

export type ShipmentLine = {
  id: string
  salesOrderShipmentId?: string
  salesOrderLineId?: string
  uom?: string
  quantityShipped?: number
  createdAt?: string
}

export type ReturnDoc = {
  id: string
  rmaNumber?: string
  customerId?: string
  salesOrderId?: string
  status?: string
  severity?: string | null
  authorizedAt?: string
  notes?: string | null
  createdAt?: string
  updatedAt?: string
  lines?: ReturnAuthorizationLine[]
}

export type ReturnAuthorizationLine = {
  id: string
  returnAuthorizationId?: string
  lineNumber?: number
  salesOrderLineId?: string | null
  itemId?: string
  uom?: string
  quantityAuthorized?: number
  reasonCode?: string | null
  notes?: string | null
  createdAt?: string
}

export type KpiSnapshot = {
  id?: string
  kpi_name: string
  value: number | string | null
  unit?: string | null
  computed_at: string
  dimensions?: Record<string, unknown> | null
  kpi_run_id?: string | null
}

export type KpiRun = {
  id?: string
  status: string
  started_at?: string | null
  finished_at?: string | null
  window_start?: string | null
  window_end?: string | null
  as_of?: string | null
  notes?: string | null
}

export type ApiNotAvailable = {
  type: 'ApiNotAvailable'
  attemptedEndpoints: string[]
}

export type PurchaseOrderLine = {
  id: string
  purchaseOrderId?: string
  lineNumber?: number
  itemId?: string
  uom?: string
  quantityOrdered?: number
  notes?: string | null
}

export type PurchaseOrder = {
  id: string
  poNumber: string
  vendorId: string
  status: string
  orderDate?: string
  expectedDate?: string
  shipToLocationId?: string
  vendorReference?: string
  notes?: string
  createdAt?: string
  updatedAt?: string
  lines?: PurchaseOrderLine[]
}

export type PurchaseOrderReceiptLine = {
  id: string
  purchaseOrderReceiptId: string
  purchaseOrderLineId: string
  uom: string
  quantityReceived: number
  createdAt: string
  qcSummary?: {
    totalQcQuantity: number
    remainingUninspectedQuantity: number
    breakdown: {
      accept: number
      reject: number
      hold: number
    }
  }
}

export type PurchaseOrderReceipt = {
  id: string
  purchaseOrderId: string
  receivedAt: string
  receivedToLocationId?: string | null
  inventoryMovementId?: string | null
  externalRef?: string | null
  notes?: string | null
  createdAt?: string
  lines?: PurchaseOrderReceiptLine[]
}

export type PutawayLine = {
  id: string
  lineNumber: number
  purchaseOrderReceiptLineId: string
  itemId: string
  uom: string
  quantityPlanned: number
  quantityMoved?: number | null
  fromLocationId: string
  toLocationId: string
  inventoryMovementId?: string | null
  status: string
  notes?: string | null
  createdAt?: string
  updatedAt?: string
  remainingQuantityToPutaway?: number
}

export type Putaway = {
  id: string
  status: string
  sourceType: string
  purchaseOrderReceiptId?: string | null
  inventoryMovementId?: string | null
  notes?: string | null
  createdAt?: string
  updatedAt?: string
  lines: PutawayLine[]
}

export type Lot = {
  id: string
  itemId: string
  lotCode: string
  status: string
  manufacturedAt?: string | null
  receivedAt?: string | null
  expiresAt?: string | null
  vendorLotCode?: string | null
  notes?: string | null
  createdAt?: string
  updatedAt?: string
}

export type MovementLotAllocation = {
  id: string
  inventoryMovementLineId: string
  lotId: string
  uom: string
  quantityDelta: number
  createdAt?: string
}
