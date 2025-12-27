import { useMemo } from 'react'
import type { PurchaseOrder } from '../../../api/types'

const staleDraftReferenceTime = Date.now()

const groupOrder = [
  { key: 'draft', title: 'Drafts', description: 'Intent in progress. No operational impact yet.' },
  { key: 'submitted', title: 'Submitted', description: 'Commitment sent. Awaiting approval.' },
  { key: 'approved', title: 'Approved', description: 'Authorized. Awaiting receipt.' },
  { key: 'closed', title: 'Closed / Received', description: 'Completed commitments.' },
] as const

export function usePurchaseOrdersGrouping(rows: PurchaseOrder[], statusFilter: string) {
  const grouped = useMemo(() => {
    const groups = {
      draft: [] as PurchaseOrder[],
      submitted: [] as PurchaseOrder[],
      approved: [] as PurchaseOrder[],
      closed: [] as PurchaseOrder[],
    }
    rows.forEach((po) => {
      const status = (po.status ?? '').toLowerCase()
      if (status === 'draft') {
        groups.draft.push(po)
      } else if (status === 'submitted') {
        groups.submitted.push(po)
      } else if (status === 'approved' || status === 'partially_received') {
        groups.approved.push(po)
      } else if (status === 'received' || status === 'closed') {
        groups.closed.push(po)
      } else {
        groups.submitted.push(po)
      }
    })
    return groups
  }, [rows])

  const staleDrafts = useMemo(() => {
    return grouped.draft.filter((po) => {
      if (!po.createdAt) return false
      const created = new Date(po.createdAt).getTime()
      if (Number.isNaN(created)) return false
      const days = Math.floor(
        (staleDraftReferenceTime - created) / (1000 * 60 * 60 * 24),
      )
      return days >= 7
    })
  }, [grouped.draft])

  const normalizedStatusFilter =
    statusFilter === 'received' || statusFilter === 'closed' ? 'closed' : statusFilter

  const statusFilterKey = groupOrder.some((group) => group.key === normalizedStatusFilter)
    ? normalizedStatusFilter
    : ''

  const visibleGroups = statusFilterKey
    ? groupOrder.filter((group) => group.key === statusFilterKey)
    : groupOrder

  return {
    grouped,
    staleDrafts,
    groupOrder,
    visibleGroups,
    statusFilterKey,
  }
}
