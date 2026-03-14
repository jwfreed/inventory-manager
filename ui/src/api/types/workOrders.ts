export type WorkOrder = {
  id: string
  number: string
  status: 'draft' | 'ready' | 'in_progress' | 'partially_completed' | 'completed' | 'closed' | 'canceled'
  kind?: 'production' | 'disassembly'
  bomId?: string
  bomVersionId?: string | null
  routingId?: string | null
  relatedWorkOrderId?: string | null
  outputItemId: string
  outputItemSku?: string
  outputItemName?: string
  outputUom: string
  quantityPlanned: number
  quantityCompleted?: number | null
  quantityScrapped?: number | null
  defaultConsumeLocationId?: string | null
  defaultProduceLocationId?: string | null
  scheduledStartAt?: string | null
  scheduledDueAt?: string | null
  releasedAt?: string | null
  completedAt?: string | null
  description?: string | null
  stageType?: 'wrapped_bar' | 'boxing' | 'generic_production' | 'disassembly'
  stageLabel?: string
  routingLocked?: boolean
  derivedConsumeLocationId?: string | null
  derivedConsumeLocationCode?: string | null
  derivedConsumeLocationName?: string | null
  derivedProduceLocationId?: string | null
  derivedProduceLocationCode?: string | null
  derivedProduceLocationName?: string | null
  reportProductionReceiveToLocationId?: string | null
  reportProductionReceiveToLocationCode?: string | null
  reportProductionReceiveToLocationName?: string | null
  reportProductionReceiveToSource?: 'routing_snapshot' | 'work_order_default' | 'warehouse_default' | null
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

export type WorkOrderReadinessLine = WorkOrderRequirementLine & {
  required: number
  reserved: number
  available: number
  shortage: number
  blocked: boolean
  reservationId?: string | null
  reservationStatus?: string | null
  fulfilled?: number
  consumeLocationId?: string | null
  consumeLocationCode?: string | null
  consumeLocationName?: string | null
  consumeLocationRole?: string | null
}

export type WorkOrderReadiness = {
  workOrderId: string
  stageType: 'wrapped_bar' | 'boxing' | 'generic_production' | 'disassembly'
  stageLabel: string
  status: string
  consumeLocation?: {
    id: string
    code: string
    name: string
    role?: string | null
  } | null
  produceLocation?: {
    id: string
    code: string
    name: string
    role?: string | null
  } | null
  quantities: {
    planned: number
    produced: number
    scrapped: number
    remaining: number
  }
  hasShortage: boolean
  executionSummary?: WorkOrderExecutionSummary | null
  reservations: {
    id?: string | null
    status?: string | null
    componentItemId: string
    componentItemSku?: string | null
    componentItemName?: string | null
    locationId: string
    locationCode?: string | null
    locationName?: string | null
    uom: string
    requiredQty: number
    reservedQty: number
    fulfilledQty: number
  }[]
  lines: WorkOrderReadinessLine[]
}

export type WorkOrderDisassemblyPlan = {
  workOrderId: string
  status: string
  bomId: string
  bomVersionId: string
  consumeItemId: string
  consumeItemSku?: string | null
  consumeItemName?: string | null
  consumeLocation?: {
    id: string
    code: string
    name: string
    role?: string | null
  } | null
  quantities: {
    planned: number
    produced: number
    scrapped: number
    remaining: number
    requestedDisassembly: number
  }
  outputs: {
    componentItemId: string
    componentItemSku?: string | null
    componentItemName?: string | null
    toLocationId: string
    toLocationCode?: string | null
    toLocationName?: string | null
    toLocationRole?: string | null
    quantityProduced: number
    uom: string
  }[]
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
    quantityScrapped?: number
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

export type WorkOrderVoidReportResult = {
  workOrderId: string
  workOrderExecutionId: string
  componentReturnMovementId: string
  outputReversalMovementId: string
  idempotencyKey: string | null
  replayed: boolean
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
