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
  notes?: string | null
}

export type MovementListResponse = {
  data: Movement[]
  total?: number
  page?: number
  pageSize?: number
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
  notes?: string | null
}

export type WorkOrderListResponse = {
  data: WorkOrder[]
  paging?: { limit: number; offset: number }
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
  completedTotals: { outputItemId: string; uom: string; quantityCompleted: number }[]
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

export type SalesOrder = {
  id: string
  soNumber: string
  status?: string
  customerName?: string
  orderDate?: string
  requestedShipDate?: string
  shipFromLocationId?: string
  lines?: SalesOrderLine[]
  shipments?: Shipment[]
}

export type SalesOrderLine = {
  id: string
  lineNumber?: number
  itemId?: string
  itemSku?: string
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
  quantityFulfilled?: number
}

export type Shipment = {
  id: string
  salesOrderId?: string
  status?: string
  shippedAt?: string
  shipFromLocationId?: string
  inventoryMovementId?: string | null
  lines?: ShipmentLine[]
}

export type ShipmentLine = {
  id: string
  itemId?: string
  uom?: string
  quantity?: number
}

export type ReturnDoc = {
  id: string
  status?: string
  type?: string
  inventoryMovementId?: string | null
  notes?: string | null
}
