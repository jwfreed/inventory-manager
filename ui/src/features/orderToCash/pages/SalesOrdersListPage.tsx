import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listSalesOrders } from '../../../api/endpoints/orderToCash/salesOrders'
import type { ApiError } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { formatDate } from '../../../lib/formatters'

export default function SalesOrdersListPage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')

  const { data, isLoading, isError, error, refetch } = useQuery<
    Awaited<ReturnType<typeof listSalesOrders>>,
    ApiError
  >({
    queryKey: ['sales-orders'],
    queryFn: () => listSalesOrders(),
    retry: 1,
  })

  const filtered = useMemo(() => {
    const list = data?.data ?? []
    const statusFiltered = status ? list.filter((so) => so.status === status) : list
    if (!search) return statusFiltered
    const needle = search.toLowerCase()
    return statusFiltered.filter(
      (so) =>
        so.soNumber.toLowerCase().includes(needle) ||
        (so.customerId || '').toLowerCase().includes(needle),
    )
  }, [data?.data, search, status])

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Order to Cash</p>
        <h2 className="text-2xl font-semibold text-slate-900">Sales Orders</h2>
        <p className="max-w-3xl text-sm text-slate-600">
          Create and browse orders. Documents do not change inventory unless linked to posted movements.
        </p>
        <div>
          <Button size="sm" onClick={() => navigate('/sales-orders/new')}>
            New sales order
          </Button>
        </div>
      </div>

      <Section title="Filters">
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="submitted">Submitted</option>
            <option value="partially_shipped">Partially Shipped</option>
            <option value="shipped">Shipped</option>
            <option value="closed">Closed</option>
            <option value="canceled">Canceled</option>
          </select>
          <input
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            placeholder="Search SO number or customer"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Refresh
          </Button>
        </div>
      </Section>

      <Section title="Sales orders">
        <Card>
          {isLoading && <LoadingSpinner label="Loading sales orders..." />}
          {isError && error && (
            <Alert variant="error" title="Failed to load" message={error.message} />
          )}
          {!isLoading && !isError && filtered.length === 0 && (
            <EmptyState
              title="No sales orders found"
              description="Create sales orders via the New button, API, or seed data."
            />
          )}
          {!isLoading && !isError && filtered.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      SO Number
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Customer
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Order date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Requested ship
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {filtered.map((so) => (
                    <tr
                      key={so.id}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => navigate(`/sales-orders/${so.id}`)}
                    >
                      <td className="px-4 py-3 text-sm font-semibold text-slate-900">
                        {so.soNumber}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        <Badge variant="neutral">{so.status || '—'}</Badge>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-700">{so.customerId || '—'}</td>
                      <td className="px-4 py-3 text-sm text-slate-700">
                        {so.orderDate ? formatDate(so.orderDate) : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-700">
                        {so.requestedShipDate ? formatDate(so.requestedShipDate) : '—'}
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
