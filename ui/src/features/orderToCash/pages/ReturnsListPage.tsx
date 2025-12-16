import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listReturns } from '../../../api/endpoints/orderToCash/returns'
import type { ApiError } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'

export default function ReturnsListPage() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')

  const { data, isLoading, isError, error, refetch } = useQuery<
    Awaited<ReturnType<typeof listReturns>>,
    ApiError
  >({
    queryKey: ['returns'],
    queryFn: () => listReturns(),
    retry: 1,
  })

  const notImplemented = data?.notImplemented

  const filtered = useMemo(() => {
    const list = data?.data ?? []
    if (!search) return list
    const needle = search.toLowerCase()
    return list.filter((r) => (r.id || '').toLowerCase().includes(needle))
  }, [data?.data, search])

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Order to Cash</p>
        <h2 className="text-2xl font-semibold text-slate-900">Returns</h2>
        <p className="max-w-3xl text-sm text-slate-600">
          Read-only browsing. Return documents may link to inventory movements.
        </p>
      </div>

      <Section title="Filters">
        <div className="flex flex-wrap items-center gap-3">
          <input
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            placeholder="Search by return id"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Refresh
          </Button>
        </div>
      </Section>

      <Section title="Returns">
        <Card>
          {isLoading && <LoadingSpinner label="Loading returns..." />}
          {isError && error && !notImplemented && (
            <Alert variant="error" title="Failed to load" message={error.message} />
          )}
          {notImplemented && (
            <EmptyState
              title="API not available yet"
              description="Expected endpoint: GET /returns (Phase 4 runtime may be DB-only)."
            />
          )}
          {!isLoading && !isError && !notImplemented && filtered.length === 0 && (
            <EmptyState
              title="No returns found"
              description="Create returns via API. This UI is read-only."
            />
          )}
          {!isLoading && !isError && !notImplemented && filtered.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Return ID
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Type
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Movement
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {filtered.map((r) => (
                    <tr
                      key={r.id}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => navigate(`/returns/${r.id}`)}
                    >
                      <td className="px-4 py-3 text-sm font-semibold text-slate-900">{r.id}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        <Badge variant="neutral">{r.status || '—'}</Badge>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-800">{r.type || '—'}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        {r.inventoryMovementId ? <Badge variant="info">Movement linked</Badge> : '—'}
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
