export type ReceiptLineInput = {
  purchaseOrderLineId: string
  lineNumber: number
  itemLabel: string
  uom: string
  expectedQty: number
  receivedQty: number | ''
  unitCost?: number | ''
  discrepancyReason: '' | 'short' | 'over' | 'damaged' | 'substituted'
  discrepancyNotes: string
}

export type ReceiptLineSummaryLine = ReceiptLineInput & {
  receivedQty: number
  expectedQty: number
  delta: number
  remaining: number
}

export type ReceiptLineSummary = {
  lines: ReceiptLineSummaryLine[]
  receivedLines: ReceiptLineSummaryLine[]
  discrepancyLines: ReceiptLineSummaryLine[]
  missingReasons: ReceiptLineSummaryLine[]
  remainingLines: ReceiptLineSummaryLine[]
  totalExpected: number
  totalReceived: number
}

export type QcDraft = {
  lineId: string
  eventType: 'accept' | 'hold' | 'reject'
  quantity: number | ''
  reasonCode: string
  notes: string
}

export type PutawayLineInput = {
  purchaseOrderReceiptLineId: string
  toLocationId: string
  fromLocationId: string
  uom: string
  quantity: number | ''
}

export type ReceiptLineOption = {
  value: string
  label: string
  uom: string
  quantity: number
  acceptedQty: number
  availableQty: number
  holdQty: number
  rejectQty: number
  remainingQty: number
  blockedReason: string
  defaultToLocationId: string
  defaultFromLocationId: string
}
