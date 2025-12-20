import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
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
  const [repeatMessage, setRepeatMessage] = useState<string | null>(null)
  const [repeatError, setRepeatError] = useState<string | null>(null)

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

  return (
    <div className="space-y-6">
      <Section title="Purchase Orders" description="View recent POs and repeat them quickly.">
        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-600">
            Showing last {formatNumber(rows.length)} POs (latest first).
          </div>
          <Link to="/purchase-orders/new">
            <Button size="sm">Create PO</Button>
          </Link>
        </div>
        {repeatMessage && <Alert variant="success" title="PO repeated" message={repeatMessage} />}
        {repeatError && <Alert variant="error" title="Repeat failed" message={repeatError} />}
        <Card className="mt-3">
          {poQuery.isLoading && <LoadingSpinner label="Loading purchase orders..." />}
          {poQuery.isError && poQuery.error && (
            <Alert variant="error" title="Error" message={(poQuery.error as ApiError).message} />
          )}
          {!poQuery.isLoading && rows.length === 0 && (
            <div className="py-6 text-sm text-slate-600">No purchase orders yet.</div>
          )}
          {!poQuery.isLoading && rows.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-slate-200">
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
                      Ship to
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Status
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Order date
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Expected
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {rows.map((po: PurchaseOrder) => (
                    <tr key={po.id}>
                      <td className="px-3 py-2 text-sm text-slate-800">
                        <Link to={`/purchase-orders/${po.id}`} className="text-brand-700 underline">
                          {po.poNumber}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-sm text-slate-800">
                        {po.vendorCode ?? po.vendorId}
                        {po.vendorName ? ` — ${po.vendorName}` : ''}
                      </td>
                      <td className="px-3 py-2 text-sm text-slate-800">{po.shipToLocationCode ?? po.shipToLocationId ?? '—'}</td>
                      <td className="px-3 py-2 text-sm text-slate-800 capitalize">{po.status}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">{po.orderDate ?? '—'}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">{po.expectedDate ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-sm text-slate-800">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => repeatMutation.mutate(po.id)}
                            disabled={repeatMutation.isPending}
                          >
                            {repeatMutation.isPending ? 'Repeating…' : 'Repeat'}
                          </Button>
                          <Link to="/purchase-orders/new">
                            <Button variant="secondary" size="sm">New</Button>
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Section>
    </div>
  )
}
