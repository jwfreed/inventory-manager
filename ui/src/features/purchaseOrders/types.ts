export type PurchaseOrderLineDraft = {
  itemId: string
  uom: string
  quantityOrdered: number | ''
  unitPrice?: number | ''
  notes?: string
  lineNumber?: number
}

export type PurchaseOrderLineStats = {
  valid: (PurchaseOrderLineDraft & { lineNumber: number })[]
  missingCount: number
  totalQty: number
  withIntentCount: number
}

export type PurchaseOrderLineValidation = {
  hasIntent: boolean
  isValid: boolean
  uom: string
  quantity: number | null
  unitPrice: number | null
  lineTotal: number | null
  defaultUom?: string | null
  uomMismatch: boolean
  errors: {
    itemId?: string
    uom?: string
    quantityOrdered?: string
  }
}
