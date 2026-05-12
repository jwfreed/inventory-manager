import type { PurchaseOrder, PurchaseOrderReceiptLine } from '@api/types'
import { formatNumber } from '../../lib/formatters'
import type { ReceiptLineInput, ReceiptLineSummary } from './types'

const QUANTITY_EPSILON = 1e-6

const toQuantityNumber = (value: unknown): number => {
  if (value === '' || value === null || value === undefined) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export const normalizeReceiptQuantity = toQuantityNumber

export const parseReceiptQuantityForValidation = (value: unknown): { value: number; valid: boolean } => {
  if (value === '') return { value: 0, valid: true }
  const parsed = Number(value)
  return { value: Number.isFinite(parsed) ? parsed : 0, valid: Number.isFinite(parsed) }
}

export const formatReceiptQuantity = (value: unknown): string => {
  return formatNumber(toQuantityNumber(value))
}

export const formatQuantityWithUom = (value: unknown, uom: string): string => {
  return `${formatReceiptQuantity(value)} ${uom || 'units'}`
}

export const formatReceiptQuantitySummary = (summary: ReceiptLineSummary): string => {
  if (summary.lines.length === 0) return 'No receipt lines'

  const groups = new Map<string, { uom: string; expected: number; received: number }>()
  for (const line of summary.lines) {
    const uom = line.uom || 'units'
    const current = groups.get(uom) ?? { uom, expected: 0, received: 0 }
    current.expected += toQuantityNumber(line.expectedQty)
    current.received += toQuantityNumber(line.receivedQty)
    groups.set(uom, current)
  }

  const totals = [...groups.values()]
  const hasReceived = totals.some((group) => group.received > 0)
  const allExpectedReceived =
    hasReceived &&
    totals.every((group) => group.expected > 0 && Math.abs(group.received - group.expected) <= QUANTITY_EPSILON)

  if (allExpectedReceived) {
    return `${totals.map((group) => formatQuantityWithUom(group.received, group.uom)).join(' + ')} ready to post`
  }

  return totals
    .map((group) => {
      if (!hasReceived) {
        return `0 of ${formatQuantityWithUom(group.expected, group.uom)} received`
      }
      return `${formatReceiptQuantity(group.received)} of ${formatQuantityWithUom(group.expected, group.uom)} received`
    })
    .join(' · ')
}

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
      expectedQty: toQuantityNumber(line.quantityOrdered),
      receivedQty: toQuantityNumber(line.quantityOrdered),
      discrepancyReason: '',
      discrepancyNotes: '',
      lotCode: '',
      serialNumbers: [],
      requiresLot: line.requiresLot ?? false,
      requiresSerial: line.requiresSerial ?? false,
      requiresQc: line.requiresQc ?? false,
      overReceiptTolerancePct: line.overReceiptTolerancePct ?? 0,
      overReceiptApproved: false,
    }
  })
}

export const getQcBreakdown = (line: PurchaseOrderReceiptLine) => {
  const breakdown = line.qcSummary?.breakdown ?? { accept: 0, hold: 0, reject: 0 }
  const totalQc = breakdown.accept + breakdown.hold + breakdown.reject + (breakdown.disposed ?? 0)
  const remaining =
    line.qcSummary?.remainingUninspectedQuantity ?? Math.max(0, line.quantityReceived - totalQc)
  return { ...breakdown, remaining, totalQc }
}

export const getQcStatus = (line: PurchaseOrderReceiptLine) => {
  const { accept, hold, reject, totalQc, remaining } = getQcBreakdown(line)
  if (totalQc === 0) {
    return { label: 'QC not started', variant: 'neutral' as const }
  }
  if (remaining > 0) {
    return { label: 'QC in progress', variant: 'warning' as const }
  }
  if (hold > 0) {
    return { label: 'Hold unresolved', variant: 'warning' as const }
  }
  // All inspected with no hold and no remaining — determine accepted/rejected split.
  if (accept === 0 && reject > 0) {
    // Every unit was rejected; nothing accepted. Make this unambiguously visible.
    return { label: 'Fully rejected', variant: 'danger' as const }
  }
  if (reject > 0) {
    // Mixed result: some accepted, some rejected.
    return { label: 'Accepted with rejects', variant: 'warning' as const }
  }
  // All units accepted — explicitly say so.
  return { label: 'Accepted', variant: 'success' as const }
}
