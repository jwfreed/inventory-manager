import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listReservations } from '../../../api/endpoints/orderToCash/reservations'
import type { ApiError } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'

export default function ReservationsListPage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')

  const { data, isLoading, isError, error, refetch } = useQuery<
    Awaited<ReturnType<typeof listReservations>>,
    ApiError
  >({
    queryKey: ['reservations'],
    queryFn: () => listReservations(),
    retry: 1,
  })

  const filtered = useMemo(() => {
    const list = data?.data ?? []
    const statusFiltered = status ? list.filter((r) => r.status === status) : list
    if (!search) return statusFiltered
    const needle = search.toLowerCase()
    return statusFiltered.filter(
      (r) =>
        (r.itemId || '').toLowerCase().includes(needle) ||
        (r.locationId || '').toLowerCase().includes(needle),
    )
  }, [data?.data, search, status])

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Order to Cash</p>
        <h2 className="text-2xl font-semibold text-slate-900">Reservations</h2>
        <p className="max-w-3xl text-sm text-slate-600">
          Reservations do not change on-hand; they represent demand allocation. Read-only browsing.
        </p>
      </div>

      <Section title="Filters">
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="released">Released</option>
            <option value="fulfilled">Fulfilled</option>
            <option value="canceled">Canceled</option>
          </select>
          <input
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            placeholder="Search by item or location"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Refresh
          </Button>
        </div>
      </Section>

      <Section title="Reservations">
        <Card>
          {isLoading && <LoadingSpinner label="Loading reservations..." />}
          {isError && error && (
            <Alert variant="error" title="Failed to load" message={error.message} />
          )}
          {!isLoading && !isError && filtered.length === 0 && (
            <EmptyState
              title="No reservations found"
              description="Create reservations via API; this list is read-only."
            />
          )}
          {!isLoading && !isError && filtered.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Demand
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Item
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Location
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Reserved
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Fulfilled
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {filtered.map((r) => (
                    <tr
                      key={r.id}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => navigate(`/reservations/${r.id}`)}
                    >
                      <td className="px-4 py-3 text-sm text-slate-800">
                        <Badge variant="neutral">{r.status || '—'}</Badge>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-700">
                        {r.demandType || '—'} {r.demandId || ''}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-700">{r.itemId || '—'}</td>
                      <td className="px-4 py-3 text-sm text-slate-700">{r.locationId || '—'}</td>
                      <td className="px-4 py-3 text-right text-sm text-slate-800">
                        {r.quantityReserved ?? '—'} {r.uom || ''}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-slate-800">
                        {r.quantityFulfilled ?? '—'} {r.uom || ''}
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
