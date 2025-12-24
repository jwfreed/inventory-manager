import { useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useShipment } from '../queries'
import type { ApiError, ShipmentLine } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { formatNumber } from '../../../lib/formatters'

export default function ShipmentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const query = useShipment(id)

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

  const lines: ShipmentLine[] = query.data?.lines || []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Order to Cash</p>
          <h2 className="text-2xl font-semibold text-slate-900">Shipment detail</h2>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate('/shipments')}>
            Back to list
          </Button>
          <Button variant="secondary" size="sm" onClick={copyId}>
            Copy ID
          </Button>
        </div>
      </div>

      {query.isLoading && <LoadingSpinner label="Loading shipment..." />}
      {query.isError && query.error && !query.isLoading && (
        <ErrorState error={query.error as unknown as ApiError} onRetry={() => void query.refetch()} />
      )}

      {query.data && !query.isError && (
        <>
          <Card>
            <div className="grid gap-3 text-sm text-slate-800 md:grid-cols-2">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Shipped at</div>
                <div>{query.data.shippedAt || '—'}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Sales order</div>
                <div>{query.data.salesOrderId || '—'}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Ship from</div>
                <div>{query.data.shipFromLocationId || '—'}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Movement</div>
                {query.data.inventoryMovementId ? (
                  <Link
                    to={`/movements/${query.data.inventoryMovementId}`}
                    className="text-brand-700 hover:underline"
                  >
                    {query.data.inventoryMovementId}
                  </Link>
                ) : (
                  '—'
                )}
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">External ref</div>
                <div>{query.data.externalRef || '—'}</div>
              </div>
            </div>
            <Alert
              className="mt-3"
              variant="info"
              title="Shipment document"
              message="Shipment documents may link to an inventory movement when posted."
            />
          </Card>

          <Section title="Lines">
            {lines.length === 0 ? (
              <EmptyState
                title="No lines"
                description="No lines returned for this shipment endpoint."
              />
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Sales order line
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        UOM
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Quantity
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {lines.map((line) => (
                      <tr key={line.id}>
                        <td className="px-4 py-3 text-sm text-slate-800">
                          {line.salesOrderLineId || '—'}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-800">{line.uom || '—'}</td>
                        <td className="px-4 py-3 text-right text-sm text-slate-800">
                          {line.quantityShipped !== undefined
                            ? formatNumber(line.quantityShipped)
                            : '—'}
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
