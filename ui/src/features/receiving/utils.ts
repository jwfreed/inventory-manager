import type { PurchaseOrder, PurchaseOrderReceiptLine } from '@api/types'
import type { ReceiptLineInput } from './types'

export const buildReceiptLines = (po: PurchaseOrder): ReceiptLineInput[] => {
  return (po.lines ?? []).map((line, idx) => {
    const sku = line.itemSku ?? line.itemId ?? 'Item'
    const name = line.itemName ?? ''
    const label = `${sku}${name ? ` — ${name}` : ''}`
    return {
      purchaseOrderLineId: line.id,
      lineNumber: line.lineNumber ?? idx + 1,
      itemLabel: label,
      uom: line.uom ?? '',
      expectedQty: line.quantityOrdered ?? 0,
      receivedQty: line.quantityOrdered ?? 0,
      discrepancyReason: '',
      discrepancyNotes: '',
    }
  })
}

export const getQcBreakdown = (line: PurchaseOrderReceiptLine) => {
  const breakdown = line.qcSummary?.breakdown ?? { accept: 0, hold: 0, reject: 0 }
  const totalQc = breakdown.accept + breakdown.hold + breakdown.reject
  const remaining =
    line.qcSummary?.remainingUninspectedQuantity ?? Math.max(0, line.quantityReceived - totalQc)
  return { ...breakdown, remaining, totalQc }
}

export const getQcStatus = (line: PurchaseOrderReceiptLine) => {
  const { totalQc, remaining } = getQcBreakdown(line)
  if (totalQc === 0) {
    return { label: 'QC not started', tone: 'bg-slate-100 text-slate-600' }
  }
  if (remaining > 0) {
    return { label: 'QC in progress', tone: 'bg-amber-100 text-amber-700' }
  }
  return { label: 'QC complete', tone: 'bg-emerald-100 text-emerald-700' }
}
