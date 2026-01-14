export type PurchaseOrderReceiptLine = {
  id: string
  purchaseOrderReceiptId: string
  purchaseOrderLineId: string
  itemId?: string
  itemSku?: string | null
  itemName?: string | null
  defaultFromLocationId?: string | null
  defaultToLocationId?: string | null
  uom: string
  expectedQuantity?: number
  quantityReceived: number
  unitCost?: number | null
  discrepancyReason?: string | null
  discrepancyNotes?: string | null
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
  remainingQuantityToPutaway?: number
  availableForNewPutaway?: number
  putawayBlockedReason?: string | null
  putawayAcceptedQuantity?: number
  putawayPostedQuantity?: number
  putawayStatus?: 'not_available' | 'not_started' | 'partial' | 'complete'
}

export type QcEvent = {
  id: string
  purchaseOrderReceiptLineId: string
  eventType: 'hold' | 'accept' | 'reject'
  quantity: number
  uom: string
  reasonCode?: string | null
  notes?: string | null
  actorType: 'user' | 'system'
  actorId?: string | null
  occurredAt: string
  createdAt?: string
}

export type PurchaseOrderReceipt = {
  id: string
  purchaseOrderId: string
  purchaseOrderNumber?: string
  vendorId?: string | null
  vendorName?: string | null
  vendorCode?: string | null
  status?: 'posted' | 'voided'
  workflowStatus?:
    | 'draft'
    | 'posted'
    | 'pending_qc'
    | 'qc_passed'
    | 'qc_failed'
    | 'putaway_pending'
    | 'complete'
    | 'voided'
  qcStatus?: 'pending' | 'passed' | 'failed'
  putawayStatus?: 'not_available' | 'not_started' | 'pending' | 'complete'
  qcEligible?: boolean
  putawayEligible?: boolean
  receivedAt: string
  receivedToLocationId?: string | null
  receivedToLocationName?: string | null
  receivedToLocationCode?: string | null
  inventoryMovementId?: string | null
  externalRef?: string | null
  notes?: string | null
  createdAt?: string
  hasPutaway?: boolean | null
  draftPutawayId?: string | null
  lineCount?: number
  totalReceived?: number
  totalAccepted?: number
  totalHold?: number
  totalReject?: number
  qcRemaining?: number
  putawayPosted?: number
  putawayPending?: number
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
