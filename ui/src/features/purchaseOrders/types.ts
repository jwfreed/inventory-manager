export type PurchaseOrderLineDraft = {
  itemId: string
  uom: string
  quantityOrdered: number | ''
  notes?: string
}

export type PurchaseOrderLineStats = {
  valid: PurchaseOrderLineDraft[]
  missingCount: number
  totalQty: number
}
