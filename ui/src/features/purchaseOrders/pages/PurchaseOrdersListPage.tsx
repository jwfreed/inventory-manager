import { useMemo, useState } from 'react'
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
  const [searchParams, setSearchParams] = useSearchParams()
  const [repeatMessage, setRepeatMessage] = useState<{ label: string; id: string } | null>(null)
  const [repeatError, setRepeatError] = useState<string | null>(null)
  const [repeatPendingId, setRepeatPendingId] = useState<string | null>(null)

  const action = (searchParams.get('action') ?? '').toLowerCase()
  const isReceivingMode = action === 'receive'
  const statusFilter = (searchParams.get('status') ?? (isReceivingMode ? 'approved' : '')).toLowerCase()
  const showReceiveAction =
    isReceivingMode || ['approved', 'partially_received', 'submitted'].includes(statusFilter)

  const poQuery = usePurchaseOrdersList({ limit: 200 }, { staleTime: 30_000 })

  const repeatMutation = useMutation({
    mutationFn: async (poId: string) => {
      setRepeatMessage(null)
      setRepeatError(null)
      setRepeatPendingId(poId)
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
      setRepeatMessage({ label: `Repeated as ${created.poNumber}`, id: created.id })
      void qc.invalidateQueries({ queryKey: purchaseOrdersQueryKeys.all })
    },
    onError: (err: ApiError | unknown) => {
      setRepeatError(formatError(err))
    },
    onSettled: () => {
      setRepeatPendingId(null)
    },
  })

  const rows = poQuery.data?.data ?? []
  const { grouped, staleDrafts, visibleGroups, statusFilterKey } = usePurchaseOrdersGrouping(
    rows,
    statusFilter,
  )

  const statusOptions = useMemo(() => {
    const base = [
      { label: 'All statuses', value: '' },
      { label: 'Draft', value: 'draft' },
      { label: 'Submitted', value: 'submitted' },
      { label: 'Approved', value: 'approved' },
      { label: 'Partially received', value: 'partially_received' },
      { label: 'Closed', value: 'closed' },
      { label: 'Canceled', value: 'canceled' },
    ]
    const keys = new Set(Object.keys(grouped))
    return base.filter((opt) => !opt.value || keys.has(opt.value))
  }, [grouped])

  const setStatusFilter = (next: string) => {
    const updated = new URLSearchParams(searchParams)
    if (next) {
      updated.set('status', next)
    } else {
      updated.delete('status')
    }
    setSearchParams(updated)
  }

  const clearReceivingMode = () => {
    const updated = new URLSearchParams(searchParams)
    updated.delete('action')
    updated.delete('status')
    setSearchParams(updated)
  }

  const emptyMessage = statusFilter ? `No ${statusFilter} purchase orders.` : 'No purchase orders yet.'

  return (
    <div className="space-y-6">
      <Section title="Purchase Orders" description="Drafts are intent; submitted POs are commitments.">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-600">
            <div>
              Showing {formatNumber(statusFilterKey ? grouped[statusFilterKey]?.length ?? 0 : rows.length)} purchase
              orders
              {statusFilterKey ? '.' : ' across all states.'}
            </div>
            {statusFilter && (
              <div className="text-xs text-slate-500">Filtered by: {statusFilter.replace(/_/g, ' ')}</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Link to="/purchase-orders/new">
              <Button size="sm">Create PO</Button>
            </Link>
            <Link to="/purchase-orders?action=receive&status=approved">
              <Button size="sm" variant="secondary">
                Receive
              </Button>
            </Link>
          </div>
        </div>
        {isReceivingMode && (
          <Alert
            variant="info"
            title="Receiving mode"
            message="Select a PO to open Receiving with the PO preselected."
            action={
              <button
                className="text-xs font-semibold uppercase text-sky-700"
                type="button"
                onClick={clearReceivingMode}
              >
                Exit receiving mode
              </button>
            }
          />
        )}
        <PurchaseOrdersSummaryCards grouped={grouped} staleDraftCount={staleDrafts.length} />
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</span>
          <select
            className="rounded-lg border border-slate-200 px-2 py-1 text-sm"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            {statusOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {['draft', 'submitted', 'approved']
              .filter((key) => statusOptions.some((opt) => opt.value === key))
              .map((key) => (
                <button
                  key={key}
                  className={`rounded-full border px-3 py-1 ${
                    statusFilter === key
                      ? 'border-brand-400 bg-brand-50 text-brand-700'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                  type="button"
                  onClick={() => setStatusFilter(key)}
                >
                  {key.replace(/_/g, ' ')}
                </button>
              ))}
          </div>
        </div>
        {repeatMessage && (
          <Alert
            variant="success"
            title="PO repeated"
            message={repeatMessage.label}
            action={
              <Link className="text-xs font-semibold uppercase text-green-700" to={`/purchase-orders/${repeatMessage.id}`}>
                Open PO
              </Link>
            }
          />
        )}
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
                repeatPendingId={repeatPendingId}
                onClearFilters={statusFilter ? () => setStatusFilter('') : undefined}
              />
            ))}
        </div>
      </Section>
    </div>
  )
}
