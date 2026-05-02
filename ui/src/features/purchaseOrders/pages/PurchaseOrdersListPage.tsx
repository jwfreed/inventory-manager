import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { getPurchaseOrder, createPurchaseOrder } from '../api/purchaseOrders'
import { purchaseOrdersQueryKeys, usePurchaseOrdersList } from '../queries'
import type { ApiError } from '@api/types'
import { Alert, Banner, Button, EmptyState, LoadingSpinner, PageHeader, Section, SectionHeader } from '@shared/ui'
import { formatNumber } from '@shared/formatters'
import { PurchaseOrdersSummaryCards } from '../components/PurchaseOrdersSummaryCards'
import { PurchaseOrdersGroupTable } from '../components/PurchaseOrdersGroupTable'
import { usePurchaseOrdersGrouping } from '../hooks/usePurchaseOrdersGrouping'
import { useAuth } from '@shared/auth'

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
  const { hasPermission } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [repeatMessage, setRepeatMessage] = useState<{ label: string; id: string } | null>(null)
  const [repeatError, setRepeatError] = useState<string | null>(null)
  const [repeatPendingId, setRepeatPendingId] = useState<string | null>(null)

  const action = (searchParams.get('action') ?? '').toLowerCase()
  const isReceivingMode = action === 'receive'
  const statusFilter = (searchParams.get('status') ?? (isReceivingMode ? 'approved' : '')).toLowerCase()
  const search = searchParams.get('search') ?? ''
  const showReceiveAction =
    isReceivingMode || ['approved', 'partially_received', 'submitted'].includes(statusFilter)
  const canWritePurchaseOrders = hasPermission('purchasing:write')

  const poQuery = usePurchaseOrdersList(
    { limit: 200, search: search || undefined },
    { staleTime: 30_000 },
  )

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
  const visibleCount = statusFilterKey
    ? grouped[statusFilterKey as keyof typeof grouped]?.length ?? 0
    : rows.length

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
      <PageHeader
        title="Purchase Orders"
        subtitle="Drafts are intent; submitted purchase orders are commitments."
        meta={
          <p className="text-xs text-slate-500">
            Showing {formatNumber(visibleCount)} purchase orders
            {statusFilterKey ? '.' : ' across all states.'}
          </p>
        }
        action={
          <div className="flex items-center gap-2">
            {canWritePurchaseOrders ? (
              <Link to="/purchase-orders/new">
                <Button size="sm">Create PO</Button>
              </Link>
            ) : null}
            <Link to="/purchase-orders?action=receive&status=approved">
              <Button size="sm" variant="secondary">
                Receive
              </Button>
            </Link>
          </div>
        }
      />
      <Section>
        <SectionHeader
          title="PO Queue"
          description="Filter, review, and progress purchase orders from draft through receipt."
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-600">
            <div>Submitted POs move inbound; receiving updates on-hand and in-transit balances.</div>
            {statusFilter && (
              <div className="text-xs text-slate-500">Filtered by: {statusFilter.replace(/_/g, ' ')}</div>
            )}
          </div>
        </div>
        {isReceivingMode && (
          <Banner
            severity="info"
            title="Receiving mode"
            description="Select a PO to open Receiving with the PO preselected."
            action={
              <button
                className="text-xs font-semibold uppercase text-sky-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
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
          <input
            className="min-w-[220px] flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
            placeholder="Search PO, supplier, or item"
            value={search}
            onChange={(event) => {
              const updated = new URLSearchParams(searchParams)
              if (event.target.value) {
                updated.set('search', event.target.value)
              } else {
                updated.delete('search')
              }
              setSearchParams(updated)
            }}
          />
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
            <EmptyState title="No purchase orders found" description={emptyMessage} />
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
                canRepeat={canWritePurchaseOrders}
                onClearFilters={statusFilter ? () => setStatusFilter('') : undefined}
              />
            ))}
        </div>
      </Section>
    </div>
  )
}
