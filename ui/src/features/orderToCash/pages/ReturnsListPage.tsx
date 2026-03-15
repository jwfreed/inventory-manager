import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useReturnsList } from '../queries'
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

export default function ReturnsListPage() {
  const navigate = useNavigate()
  const { hideTitle } = usePageChrome()
  const [search, setSearch] = useState('')

  const { data, isLoading, isError, error, refetch } = useReturnsList({ limit: 100 })

  const filtered = useMemo(() => {
    const list = data?.data ?? []
    if (!search) return list
    const needle = search.toLowerCase()
    return list.filter((returnDoc) =>
      [returnDoc.id, returnDoc.rmaNumber, returnDoc.customerId, returnDoc.salesOrderId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    )
  }, [data?.data, search])

  return (
    <div className="space-y-6">
      <PageHeader
        title={hideTitle ? '' : 'Returns'}
        subtitle="Create and manage return authorizations, receipts, and dispositions without inventing non-existent posting APIs."
        action={
          <div className="flex gap-2">
            <Button size="sm" onClick={() => navigate('/returns/new')}>
              New return authorization
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void refetch()}>
              Refresh
            </Button>
          </div>
        }
      />

      <Panel title="Search" description="Search returns by RMA number, customer, sales order, or return id.">
        <input
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
          placeholder="Search by return id, customer, or sales order"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </Panel>

      <Panel title="Return authorizations" description="Return authorizations document approval. Receipts and dispositions can be executed from the return detail view.">
        <Card>
          {isLoading && <LoadingSpinner label="Loading returns..." />}
          {isError && error && <Alert variant="error" title="Failed to load" message={error.message} />}
          {!isLoading && !isError && filtered.length === 0 ? (
            <EmptyState
              title="No returns found"
              description="Create a return authorization to begin the returns workflow."
            />
          ) : null}
          {!isLoading && !isError && filtered.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      RMA number
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Customer
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Sales order
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Authorized at
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {filtered.map((returnDoc) => (
                    <tr
                      key={returnDoc.id}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => navigate(`/returns/${returnDoc.id}`)}
                    >
                      <td className="px-4 py-3 text-sm font-semibold text-slate-900">
                        {returnDoc.rmaNumber || returnDoc.id}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        <Badge variant="neutral">{formatStatusLabel(returnDoc.status)}</Badge>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-800">{returnDoc.customerId || '—'}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">{returnDoc.salesOrderId || '—'}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        {returnDoc.authorizedAt ? formatDate(returnDoc.authorizedAt) : '—'}
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
