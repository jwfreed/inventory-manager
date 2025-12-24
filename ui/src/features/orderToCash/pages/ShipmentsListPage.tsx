import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShipmentsList } from '../queries'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'

export default function ShipmentsListPage() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')

  const { data, isLoading, isError, error, refetch } = useShipmentsList()

  const filtered = useMemo(() => {
    const list = data?.data ?? []
    if (!search) return list
    const needle = search.toLowerCase()
    return list.filter(
      (s) =>
        (s.salesOrderId || '').toLowerCase().includes(needle) ||
        (s.inventoryMovementId || '').toLowerCase().includes(needle),
    )
  }, [data?.data, search])

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Order to Cash</p>
        <h2 className="text-2xl font-semibold text-slate-900">Shipments</h2>
        <p className="max-w-3xl text-sm text-slate-600">
          Shipment documents may link to inventory movements when posted. Read-only browsing.
        </p>
      </div>

      <Section title="Filters">
        <div className="flex flex-wrap items-center gap-3">
          <input
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            placeholder="Search by sales order or movement id"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Refresh
          </Button>
        </div>
      </Section>

      <Section title="Shipments">
        <Card>
          {isLoading && <LoadingSpinner label="Loading shipments..." />}
          {isError && error && (
            <Alert variant="error" title="Failed to load" message={error.message} />
          )}
          {!isLoading && !isError && filtered.length === 0 && (
            <EmptyState title="No shipments found" description="Create shipments via API." />
          )}
          {!isLoading && !isError && filtered.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Shipped at
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Sales order
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Ship from
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Movement
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {filtered.map((s) => (
                    <tr
                      key={s.id}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => navigate(`/shipments/${s.id}`)}
                    >
                      <td className="px-4 py-3 text-sm text-slate-800">{s.shippedAt || '—'}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">{s.salesOrderId || '—'}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">{s.shipFromLocationId || '—'}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        {s.inventoryMovementId ? (
                          <Badge variant="info">Movement linked</Badge>
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
        </Card>
      </Section>
    </div>
  )
}
