export type SalesOrder = {
  id: string
  soNumber: string
  customerId: string
  warehouseId?: string | null
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
  derivedBackorderQty?: number
  unitPrice?: number | null
  currencyCode?: string | null
  exchangeRateToBase?: number | null
  lineAmount?: number | null
  baseAmount?: number | null
  notes?: string | null
}

export type Reservation = {
  id: string
  status?: string
  state?: string
  demandType?: string
  demandId?: string
  itemId?: string
  locationId?: string
  warehouseId?: string
  uom?: string
  quantityReserved?: number
  quantityFulfilled?: number | null
  reservedAt?: string
  allocatedAt?: string | null
  canceledAt?: string | null
  fulfilledAt?: string | null
  expiredAt?: string | null
  expiresAt?: string | null
  cancelReason?: string | null
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
  status?: string | null
  postedAt?: string | null
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

export type ReturnReceipt = {
  id: string
  returnAuthorizationId?: string
  status?: string
  receivedAt?: string
  receivedToLocationId?: string
  inventoryMovementId?: string | null
  externalRef?: string | null
  notes?: string | null
  createdAt?: string
  lines?: ReturnReceiptLine[]
}

export type ReturnReceiptLine = {
  id: string
  returnReceiptId?: string
  returnAuthorizationLineId?: string | null
  itemId?: string
  uom?: string
  quantityReceived?: number
  notes?: string | null
  createdAt?: string
}

export type ReturnDisposition = {
  id: string
  returnReceiptId?: string
  status?: string
  occurredAt?: string
  dispositionType?: string
  fromLocationId?: string
  toLocationId?: string | null
  inventoryMovementId?: string | null
  notes?: string | null
  createdAt?: string
  lines?: ReturnDispositionLine[]
}

export type ReturnDispositionLine = {
  id: string
  returnDispositionId?: string
  lineNumber?: number | null
  itemId?: string
  uom?: string
  quantity?: number
  notes?: string | null
  createdAt?: string
}
