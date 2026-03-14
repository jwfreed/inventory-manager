import type { PurchaseOrder, PurchaseOrderLine } from '@api/types'

function normalizeStatus(status?: string | null) {
  return String(status ?? '').toLowerCase()
}

export function hasReceiptActivity(order?: PurchaseOrder | null) {
  return (order?.lines ?? []).some((line) => (line.quantityReceived ?? 0) > 0)
}

export function getPurchaseOrderHeaderCloseOptions(order?: PurchaseOrder | null) {
  const status = normalizeStatus(order?.status)
  if (status !== 'approved' && status !== 'partially_received') return []
  if (status === 'partially_received' || hasReceiptActivity(order)) {
    return ['closed'] as const
  }
  return ['closed', 'cancelled'] as const
}

export function canClosePurchaseOrderHeader(order?: PurchaseOrder | null) {
  return getPurchaseOrderHeaderCloseOptions(order).length > 0
}

export function getPurchaseOrderHeaderCloseDisabledReason(order?: PurchaseOrder | null) {
  const status = normalizeStatus(order?.status)
  if (status === 'draft' || status === 'submitted') {
    return 'Only approved purchase orders can be closed.'
  }
  if (status === 'received') {
    return 'Received purchase orders are already complete.'
  }
  if (status === 'closed') {
    return 'This purchase order is already closed.'
  }
  if (status === 'canceled') {
    return 'Canceled purchase orders cannot be closed.'
  }
  return 'This purchase order cannot be closed in its current state.'
}

export function canClosePurchaseOrderLine(order: PurchaseOrder | null | undefined, line: PurchaseOrderLine) {
  if (!order) return false
  const orderStatus = normalizeStatus(order.status)
  const lineStatus = normalizeStatus(line.status)
  if (orderStatus !== 'approved' && orderStatus !== 'partially_received') return false
  if (lineStatus === 'complete' || lineStatus === 'closed_short' || lineStatus === 'cancelled') return false
  return true
}

export function getPurchaseOrderLineCloseDisabledReason(
  order: PurchaseOrder | null | undefined,
  line: PurchaseOrderLine,
) {
  const orderStatus = normalizeStatus(order?.status)
  const lineStatus = normalizeStatus(line.status)
  if (orderStatus !== 'approved' && orderStatus !== 'partially_received') {
    return 'Only approved or partially received purchase orders expose line close actions.'
  }
  if (lineStatus === 'complete') {
    return 'Complete lines do not need to be closed.'
  }
  if (lineStatus === 'closed_short' || lineStatus === 'cancelled') {
    return 'This line is already closed.'
  }
  return 'This line cannot be closed in its current state.'
}
