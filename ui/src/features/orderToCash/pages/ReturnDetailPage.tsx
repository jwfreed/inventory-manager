import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getReturn } from '../../../api/endpoints/orderToCash/returns'
import type { ApiError } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { formatNumber } from '../../../lib/formatters'

export default function ReturnDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const query = useQuery({
    queryKey: ['return', id],
    queryFn: () => getReturn(id as string),
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Order to Cash</p>
          <h2 className="text-2xl font-semibold text-slate-900">Return detail</h2>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate('/returns')}>
            Back to list
          </Button>
          <Button variant="secondary" size="sm" onClick={copyId}>
            Copy ID
          </Button>
        </div>
      </div>

      {query.isLoading && <LoadingSpinner label="Loading return..." />}
      {query.isError && query.error && !query.isLoading && (
        <ErrorState error={query.error as unknown as ApiError} onRetry={() => void query.refetch()} />
      )}

      {query.data && !query.isError && (
        <>
          <Card>
            <div className="grid gap-3 text-sm text-slate-800 md:grid-cols-2">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Status</div>
                <Badge variant="neutral">{query.data.status || '—'}</Badge>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">RMA Number</div>
                <div>{query.data.rmaNumber || query.data.id}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Customer</div>
                <div>{query.data.customerId || '—'}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Sales order</div>
                <div>{query.data.salesOrderId || '—'}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Notes</div>
                <div>{query.data.notes || '—'}</div>
              </div>
            </div>
            <Alert
              className="mt-3"
              variant="info"
              title="Return document"
              message="Return authorizations document intent; inventory only changes when receipts/dispositions post movements."
            />
          </Card>

          <Section title="Lines">
            {query.data.lines && query.data.lines.length > 0 ? (
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
                        Qty authorized
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Reason
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {query.data.lines.map((line) => (
                      <tr key={line.id}>
                        <td className="px-4 py-3 text-sm text-slate-800">{line.lineNumber ?? '—'}</td>
                        <td className="px-4 py-3 text-sm text-slate-800">{line.itemId || '—'}</td>
                        <td className="px-4 py-3 text-sm text-slate-800">{line.uom || '—'}</td>
                        <td className="px-4 py-3 text-right text-sm text-slate-800">
                          {line.quantityAuthorized !== undefined
                            ? formatNumber(line.quantityAuthorized)
                            : '—'}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-800">{line.reasonCode || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="No lines" description="No lines returned for this return." />
            )}
          </Section>
        </>
      )}
    </div>
  )
}
