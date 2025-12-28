import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { getPurchaseOrder, createPurchaseOrder } from '../api/purchaseOrders'
import { purchaseOrdersQueryKeys, usePurchaseOrdersList } from '../queries'
import type { ApiError } from '@api/types'
import { Alert, Button, LoadingSpinner, Section } from '@shared/ui'
import { formatNumber } from '@shared/formatters'
import { PurchaseOrdersSummaryCards } from '../components/PurchaseOrdersSummaryCards'
import { PurchaseOrdersGroupTable } from '../components/PurchaseOrdersGroupTable'
import { usePurchaseOrdersGrouping } from '../hooks/usePurchaseOrdersGrouping'

const formatError = (err: unknown) => {
  if (!err) return 'Unknown error'
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  const apiErr = err as ApiError
  if (apiErr?.message && typeof apiErr.message === 'string') return apiErr.message
  try {
    return JSON.stringify(err)
  } catch {
    return 'Unknown error'
  }
}

export default function PurchaseOrdersListPage() {
  const qc = useQueryClient()
  const [searchParams] = useSearchParams()
  const [repeatMessage, setRepeatMessage] = useState<string | null>(null)
  const [repeatError, setRepeatError] = useState<string | null>(null)

  const action = (searchParams.get('action') ?? '').toLowerCase()
  const statusFilter = (searchParams.get('status') ?? (action === 'receive' ? 'approved' : '')).toLowerCase()
  const showReceiveAction =
    action === 'receive' || ['approved', 'partially_received', 'submitted'].includes(statusFilter)

  const poQuery = usePurchaseOrdersList({ limit: 200 }, { staleTime: 30_000 })

  const repeatMutation = useMutation({
    mutationFn: async (poId: string) => {
      setRepeatMessage(null)
      setRepeatError(null)
      const po = await getPurchaseOrder(poId)
      if (!po) throw new Error('PO not found')
      const lines = (po.lines ?? [])
        .filter((l) => l.itemId)
        .map((l, idx) => ({
          itemId: l.itemId!,
          uom: l.uom!,
          quantityOrdered: l.quantityOrdered ?? 0,
          lineNumber: l.lineNumber ?? idx + 1,
          notes: l.notes ?? undefined,
        }))
      if (lines.length === 0) {
        throw new Error('Cannot repeat PO with no lines.')
      }
      const today = new Date().toISOString().slice(0, 10)
      const payload = {
        vendorId: po.vendorId,
        shipToLocationId: po.shipToLocationId,
        receivingLocationId: po.receivingLocationId ?? undefined,
        orderDate: today,
        expectedDate: po.expectedDate ?? undefined,
        notes: po.notes ?? undefined,
        lines,
      }
      const created = await createPurchaseOrder(payload)
      return created
    },
    onSuccess: (created) => {
      setRepeatMessage(`Repeated as ${created.poNumber}`)
      void qc.invalidateQueries({ queryKey: purchaseOrdersQueryKeys.all })
    },
    onError: (err: ApiError | unknown) => {
      setRepeatError(formatError(err))
    },
  })

  const rows = poQuery.data?.data ?? []
  const { grouped, staleDrafts, visibleGroups, statusFilterKey } = usePurchaseOrdersGrouping(
    rows,
    statusFilter,
  )

  const emptyMessage = statusFilter ? `No ${statusFilter} purchase orders.` : 'No purchase orders yet.'

  return (
    <div className="space-y-6">
      <Section title="Purchase Orders" description="Drafts are intent; submitted POs are commitments.">
        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-600">
            {statusFilterKey
              ? `Showing ${formatNumber(
                  grouped[statusFilterKey as keyof typeof grouped]?.length ?? 0,
                )} ${statusFilterKey} POs.`
              : `Showing ${formatNumber(rows.length)} POs across all states.`}
          </div>
          <Link to="/purchase-orders/new">
            <Button size="sm">Create PO</Button>
          </Link>
        </div>
        <PurchaseOrdersSummaryCards grouped={grouped} staleDraftCount={staleDrafts.length} />
        {showReceiveAction && (
          <Alert
            variant="info"
            title="Select a PO to receive"
            message="Choose an approved PO to open Receiving with the PO preselected."
          />
        )}
        {repeatMessage && <Alert variant="success" title="PO repeated" message={repeatMessage} />}
        {repeatError && <Alert variant="error" title="Repeat failed" message={repeatError} />}
        <div className="mt-4 space-y-4">
          {poQuery.isLoading && <LoadingSpinner label="Loading purchase orders..." />}
          {poQuery.isError && poQuery.error && (
            <Alert variant="error" title="Error" message={(poQuery.error as ApiError).message} />
          )}
          {!poQuery.isLoading && rows.length === 0 && (
            <div className="py-6 text-sm text-slate-600">{emptyMessage}</div>
          )}
          {!poQuery.isLoading &&
            rows.length > 0 &&
            visibleGroups.map((group) => (
              <PurchaseOrdersGroupTable
                key={group.key}
                group={group}
                rows={grouped[group.key]}
                showReceiveAction={showReceiveAction}
                showEmptyState={Boolean(statusFilter)}
                onRepeat={(poId) => repeatMutation.mutate(poId)}
                repeatPending={repeatMutation.isPending}
              />
            ))}
        </div>
      </Section>
    </div>
  )
}
