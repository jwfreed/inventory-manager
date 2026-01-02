export type PurchaseOrderLineDraft = {
  itemId: string
  uom: string
  quantityOrdered: number | ''
  unitPrice?: number | ''
  notes?: string
}

export type PurchaseOrderLineStats = {
  valid: PurchaseOrderLineDraft[]
  missingCount: number
  totalQty: number
}
