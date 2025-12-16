import { useEffect } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getSalesOrder } from '../../../api/endpoints/orderToCash/salesOrders'
import type { ApiError, SalesOrderLine, Shipment } from '../../../api/types'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { formatNumber } from '../../../lib/formatters'

export default function SalesOrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const query = useQuery({
    queryKey: ['sales-order', id],
    queryFn: () => getSalesOrder(id as string),
    enabled: !!id,
    retry: 1,
  })

  useEffect(() => {
    const err = query.error as unknown as ApiError | undefined
    if (query.isError && err?.status === 404) {
      navigate('/not-found', { replace: true })
    }
  }, [query.isError, query.error, navigate])

  const copyId = async () => {
    if (!id) return
    try {
      await navigator.clipboard.writeText(id)
    } catch {
      // ignore
    }
  }

  const lines: SalesOrderLine[] = query.data?.lines || []
  const shipments: Shipment[] = query.data?.shipments || []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Order to Cash</p>
          <h2 className="text-2xl font-semibold text-slate-900">Sales order detail</h2>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate('/sales-orders')}>
            Back to list
          </Button>
          <Button variant="secondary" size="sm" onClick={copyId}>
            Copy ID
          </Button>
        </div>
      </div>

      {query.isLoading && <LoadingSpinner label="Loading sales order..." />}
      {query.isError && query.error && !query.isLoading && (
        <ErrorState error={query.error as unknown as ApiError} onRetry={() => void query.refetch()} />
      )}

      {query.data && !query.isError && (
        <>
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">SO Number</div>
                <div className="text-xl font-semibold text-slate-900">{query.data.soNumber}</div>
                <div className="mt-2 flex items-center gap-2">
                  <Badge variant="neutral">{query.data.status || '—'}</Badge>
                </div>
                <div className="mt-2 text-sm text-slate-700">
                  Customer: {query.data.customerId || '—'}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Documents do not affect on-hand until corresponding inventory movements post.
                </div>
              </div>
            </div>
          </Card>

          <Section title="Lines">
            {lines.length === 0 ? (
              <EmptyState title="No lines" description="No lines returned for this sales order." />
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Line
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Item
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        UOM
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Qty ordered
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Notes
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {lines.map((line) => (
                      <tr key={line.id}>
                        <td className="px-4 py-3 text-sm text-slate-800">{line.lineNumber ?? '—'}</td>
                        <td className="px-4 py-3 text-sm text-slate-800">{line.itemId || '—'}</td>
                        <td className="px-4 py-3 text-sm text-slate-800">{line.uom || '—'}</td>
                        <td className="px-4 py-3 text-right text-sm text-slate-800">
                          {line.quantityOrdered !== undefined ? formatNumber(line.quantityOrdered) : '—'}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-700">{line.notes || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title="Shipments">
            {shipments.length === 0 ? (
              <EmptyState
                title="No shipments linked"
                description="Shipments are available via the shipments list; this endpoint returns order data only."
              />
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Shipped at
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Movement
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {shipments.map((shipment) => (
                      <tr key={shipment.id}>
                        <td className="px-4 py-3 text-sm text-slate-800">{shipment.shippedAt || '—'}</td>
                        <td className="px-4 py-3 text-sm text-slate-800">
                          {shipment.inventoryMovementId ? (
                            <Link
                              to={`/ledger/movements/${shipment.inventoryMovementId}`}
                              className="text-brand-700 hover:underline"
                            >
                              {shipment.inventoryMovementId}
                            </Link>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  )
}
