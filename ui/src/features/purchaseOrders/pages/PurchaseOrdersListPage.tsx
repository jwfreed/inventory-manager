import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listPurchaseOrders, getPurchaseOrder, createPurchaseOrder } from '../../../api/endpoints/purchaseOrders'
import type { ApiError, PurchaseOrder } from '../../../api/types'
import { Section } from '../../../components/Section'
import { Card } from '../../../components/Card'
import { Button } from '../../../components/Button'
import { Alert } from '../../../components/Alert'
import { LoadingSpinner } from '../../../components/Loading'
import { formatNumber } from '../../../lib/formatters'

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
  const statusFilter = (searchParams.get('status') ?? (action === 'receive' ? 'submitted' : '')).toLowerCase()
  const showReceiveAction = action === 'receive' || statusFilter === 'submitted'
  const normalizedStatusFilter =
    statusFilter === 'received' || statusFilter === 'closed' ? 'closed' : statusFilter

  const poQuery = useQuery({
    queryKey: ['purchase-orders'],
    queryFn: () => listPurchaseOrders({ limit: 200 }),
    staleTime: 30_000,
  })

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
      void qc.invalidateQueries({ queryKey: ['purchase-orders'] })
    },
    onError: (err: ApiError | unknown) => {
      setRepeatError(formatError(err))
    },
  })

  const rows = useMemo(() => poQuery.data?.data ?? [], [poQuery.data])
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
      } else if (status === 'approved') {
        groups.approved.push(po)
      } else if (status === 'received' || status === 'closed') {
        groups.closed.push(po)
      } else {
        groups.submitted.push(po)
      }
    })
    return groups
  }, [rows])

  const now = Date.now()
  const staleDrafts = useMemo(() => {
    return grouped.draft.filter((po) => {
      if (!po.createdAt) return false
      const created = new Date(po.createdAt).getTime()
      if (Number.isNaN(created)) return false
      const days = Math.floor((now - created) / (1000 * 60 * 60 * 24))
      return days >= 7
    })
  }, [grouped.draft, now])

  const groupOrder = [
    { key: 'draft', title: 'Drafts', description: 'Intent in progress. No operational impact yet.' },
    { key: 'submitted', title: 'Submitted', description: 'Commitment sent. Awaiting approval.' },
    { key: 'approved', title: 'Approved', description: 'Authorized. Awaiting receipt.' },
    { key: 'closed', title: 'Closed / Received', description: 'Completed commitments.' },
  ] as const

  const statusFilterKey = groupOrder.some((group) => group.key === normalizedStatusFilter)
    ? normalizedStatusFilter
    : ''
  const visibleGroups = statusFilterKey
    ? groupOrder.filter((group) => group.key === statusFilterKey)
    : groupOrder

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
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <Card className="p-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">Drafts</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{grouped.draft.length}</div>
            <div className="text-xs text-slate-500">Safe, not committed</div>
            {staleDrafts.length > 0 && (
              <div className="mt-2 text-xs text-amber-700">{staleDrafts.length} older than 7 days</div>
            )}
          </Card>
          <Card className="p-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">Submitted</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{grouped.submitted.length}</div>
            <div className="text-xs text-slate-500">Awaiting approval</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">Approved</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{grouped.approved.length}</div>
            <div className="text-xs text-slate-500">Awaiting receipt</div>
          </Card>
        </div>
        {showReceiveAction && (
          <Alert
            variant="info"
            title="Select a PO to receive"
            message="Choose a submitted PO to open Receiving with the PO preselected."
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
            visibleGroups.map((group) => {
              const groupRows = grouped[group.key]
              if (!statusFilter && groupRows.length === 0) {
                return null
              }
              return (
                <Card key={group.key} className="p-0">
                  <div className="border-b border-slate-200 px-4 py-3">
                    <div className="text-sm font-semibold text-slate-800">{group.title}</div>
                    <p className="text-xs text-slate-500">{group.description}</p>
                  </div>
                  {groupRows.length === 0 ? (
                    <div className="px-4 py-4 text-sm text-slate-600">No {group.title.toLowerCase()}.</div>
                  ) : (
                    <div className="overflow-hidden rounded-b-lg border border-t-0 border-slate-200">
                      <table className="min-w-full divide-y divide-slate-200">
                        <thead className="bg-slate-50">
                          <tr>
                            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                              PO #
                            </th>
                            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                              Vendor
                            </th>
                            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                              Expected
                            </th>
                            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                              Ship to
                            </th>
                            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                              Next step
                            </th>
                            <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                              Actions
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 bg-white">
                          {groupRows.map((po) => {
                            const status = (po.status ?? '').toLowerCase()
                            const isDraft = status === 'draft'
                            const isSubmitted = status === 'submitted'
                            const isApproved = status === 'approved'
                            const createdAt = po.createdAt ? new Date(po.createdAt).getTime() : null
                            const isStaleDraft =
                              isDraft && createdAt && !Number.isNaN(createdAt)
                                ? Math.floor((now - createdAt) / (1000 * 60 * 60 * 24)) >= 7
                                : false
                            const nextStep = isDraft
                              ? 'Complete draft'
                              : isSubmitted
                              ? 'Await approval'
                              : isApproved
                              ? 'Receive items'
                              : 'Closed'
                            return (
                              <tr key={po.id}>
                                <td className="px-3 py-2 text-sm text-slate-800">
                                  <Link
                                    to={showReceiveAction ? `/receiving?poId=${po.id}` : `/purchase-orders/${po.id}`}
                                    className="text-brand-700 underline"
                                  >
                                    {po.poNumber}
                                  </Link>
                                  {isStaleDraft && (
                                    <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                                      Stale
                                    </span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-sm text-slate-800">
                                  {po.vendorCode ?? po.vendorId}
                                  {po.vendorName ? ` — ${po.vendorName}` : ''}
                                </td>
                                <td className="px-3 py-2 text-sm text-slate-800">{po.expectedDate ?? '—'}</td>
                                <td className="px-3 py-2 text-sm text-slate-800">
                                  {po.shipToLocationCode ?? po.shipToLocationId ?? '—'}
                                </td>
                                <td className="px-3 py-2 text-sm text-slate-700">{nextStep}</td>
                                <td className="px-3 py-2 text-right text-sm text-slate-800">
                                  <div className="flex justify-end gap-2">
                                    {showReceiveAction && isSubmitted && (
                                      <Link to={`/receiving?poId=${po.id}`}>
                                        <Button variant="secondary" size="sm">
                                          Receive
                                        </Button>
                                      </Link>
                                    )}
                                    <Link to={`/purchase-orders/${po.id}`}>
                                      <Button variant="secondary" size="sm">
                                        View
                                      </Button>
                                    </Link>
                                    <Button
                                      variant="secondary"
                                      size="sm"
                                      onClick={() => repeatMutation.mutate(po.id)}
                                      disabled={repeatMutation.isPending}
                                    >
                                      {repeatMutation.isPending ? 'Repeating…' : 'Repeat'}
                                    </Button>
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              )
            })}
        </div>
      </Section>
    </div>
  )
}
