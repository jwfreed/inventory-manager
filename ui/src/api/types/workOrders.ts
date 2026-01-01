export type WorkOrder = {
  id: string
  number: string
  status: string
  kind?: 'production' | 'disassembly'
  bomId?: string
  bomVersionId?: string | null
  relatedWorkOrderId?: string | null
  outputItemId: string
  outputItemSku?: string
  outputItemName?: string
  outputUom: string
  quantityPlanned: number
  quantityCompleted?: number | null
  defaultConsumeLocationId?: string | null
  defaultProduceLocationId?: string | null
  scheduledStartAt?: string | null
  scheduledDueAt?: string | null
  releasedAt?: string | null
  completedAt?: string | null
  description?: string | null
}

export type WorkOrderListResponse = {
  data: WorkOrder[]
  paging?: { limit: number; offset: number }
}

export type WorkOrderRequirementLine = {
  lineNumber: number
  componentItemId: string
  componentItemSku?: string
  componentItemName?: string
  uom: string
  quantityRequired: number
  usesPackSize?: boolean
  variableUom?: string | null
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

export type WorkOrderExecutionSummary = {
  workOrder: {
    id: string
    status: string
    kind?: 'production' | 'disassembly'
    bomId?: string | null
    bomVersionId?: string | null
    outputItemId: string
    outputUom: string
    quantityPlanned: number
    quantityCompleted: number
    completedAt?: string | null
  }
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
    reasonCode?: string | null
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
    reasonCode?: string | null
    notes?: string | null
  }[]
}
