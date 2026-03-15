import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useShipmentsList } from '../queries'
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  Panel,
} from '@shared/ui'
import { formatDate } from '@shared/formatters'
import { formatStatusLabel } from '@shared/ui'
import { usePageChrome } from '../../../app/layout/usePageChrome'

export default function ShipmentsListPage() {
  const navigate = useNavigate()
  const { hideTitle } = usePageChrome()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')

  const { data, isLoading, isError, error, refetch } = useShipmentsList({ limit: 100 })

  const filtered = useMemo(() => {
    const list = data?.data ?? []
    const statusFiltered = status
      ? list.filter((shipment) => (shipment.status ?? '').toLowerCase() === status)
      : list
    if (!search) return statusFiltered
    const needle = search.toLowerCase()
    return statusFiltered.filter((shipment) =>
      [shipment.salesOrderId, shipment.inventoryMovementId, shipment.externalRef, shipment.id]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    )
  }, [data?.data, search, status])

  return (
    <div className="space-y-6">
      <PageHeader
        title={hideTitle ? '' : 'Shipments'}
        subtitle="Review shipment documents before and after posting. Posted shipments link to authoritative movement entries."
        action={
          <div className="flex gap-2">
            <Link to="/sales-orders">
              <Button size="sm" variant="secondary">
                Sales orders
              </Button>
            </Link>
            <Button variant="secondary" size="sm" onClick={() => void refetch()}>
              Refresh
            </Button>
          </div>
        }
      />

      <Panel title="Filters" description="Search shipments by sales order, movement, external reference, or status.">
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">All statuses</option>
            <option value="posted">Posted</option>
            <option value="draft">Draft</option>
            <option value="canceled">Canceled</option>
          </select>
          <input
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            placeholder="Search by sales order, movement, or external ref"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </Panel>

      <Panel title="Shipments" description="Shipment posting performs the final inventory validation and writes the outbound movement ledger.">
        <Card>
          {isLoading && <LoadingSpinner label="Loading shipments..." />}
          {isError && error && <Alert variant="error" title="Failed to load" message={error.message} />}
          {!isLoading && !isError && filtered.length === 0 ? (
            <EmptyState
              title="No shipments found"
              description="Create a shipment from a sales order to begin outbound execution."
            />
          ) : null}
          {!isLoading && !isError && filtered.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Shipment
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Sales order
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Shipped at
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Movement
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {filtered.map((shipment) => (
                    <tr
                      key={shipment.id}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => navigate(`/shipments/${shipment.id}`)}
                    >
                      <td className="px-4 py-3 text-sm font-semibold text-slate-900">{shipment.id}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        <Badge variant="neutral">{formatStatusLabel(shipment.status)}</Badge>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-800">{shipment.salesOrderId || '—'}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        {shipment.shippedAt ? formatDate(shipment.shippedAt) : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        {shipment.inventoryMovementId ? 'Posted movement linked' : 'Pending post'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Card>
      </Panel>
    </div>
  )
}
