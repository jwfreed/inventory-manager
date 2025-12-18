import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listItems } from '../../../api/endpoints/items'
import type { ApiError, Item } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { formatDate } from '../../../lib/formatters'
import { ItemForm } from '../components/ItemForm'

const activeOptions = [
  { label: 'All', value: '' },
  { label: 'Active', value: 'true' },
  { label: 'Inactive', value: 'false' },
]

const typeLabels: Record<string, string> = {
  raw: 'Raw',
  wip: 'WIP',
  finished: 'Finished',
  packaging: 'Packaging',
}

export default function ItemsListPage() {
  const navigate = useNavigate()
  const [active, setActive] = useState('')
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  const { data, isLoading, isError, error, refetch } = useQuery<{ data: Item[] }, ApiError>({
    queryKey: ['items', active],
    queryFn: () =>
      listItems({
        active: active === '' ? undefined : active === 'true',
      }),
    retry: 1,
  })

  const filtered = useMemo(() => {
    const list = data?.data ?? []
    if (!search) return list
    const needle = search.toLowerCase()
    return list.filter(
      (item) =>
        item.sku.toLowerCase().includes(needle) || item.name.toLowerCase().includes(needle),
    )
  }, [data?.data, search])

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Master data</p>
        <h2 className="text-2xl font-semibold text-slate-900">Items</h2>
        <p className="max-w-3xl text-sm text-slate-600">
          Browse items or add new ones. Use the form below or click a row to view details and edit.
        </p>
      </div>

      <Section title="Create item">
        <div className="flex justify-end pb-2">
          <Button variant="secondary" size="sm" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? 'Hide form' : 'New item'}
          </Button>
        </div>
        {showCreate && (
          <ItemForm
            onSuccess={(item) => {
              setShowCreate(false)
              void refetch()
              navigate(`/items/${item.id}`)
            }}
          />
        )}
      </Section>

      <Section title="Filters">
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={active}
            onChange={(e) => setActive(e.target.value)}
          >
            {activeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <input
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            placeholder="Search by SKU or name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Refresh
          </Button>
        </div>
      </Section>

      <Section title="Items">
        <Card>
          {isLoading && <LoadingSpinner label="Loading items..." />}
          {isError && error && (
            <Alert
              variant="error"
              title="Failed to load items"
              message={error.message || 'Endpoint may be missing.'}
              action={
                <Button size="sm" variant="secondary" onClick={() => void refetch()}>
                  Retry
                </Button>
              }
            />
          )}
          {!isLoading && !isError && filtered.length === 0 && (
            <EmptyState
              title="No items yet"
              description="Create items via API or migrations. This UI is read-only."
            />
          )}
          {!isLoading && !isError && filtered.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      SKU
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Name
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Type
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Default UOM
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Default location
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Active
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Created
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {filtered.map((item) => (
                    <tr
                      key={item.id}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => navigate(`/items/${item.id}`)}
                    >
                      <td className="px-4 py-3 text-sm font-semibold text-slate-900">{item.sku}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">{item.name}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        <Badge variant="neutral">{typeLabels[item.type] ?? item.type}</Badge>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        {item.defaultUom || '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        {item.defaultLocationCode || item.defaultLocationName || '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        <Badge variant={item.active ? 'success' : 'danger'}>
                          {item.active ? 'Active' : 'Inactive'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-700">
                        {item.createdAt ? formatDate(item.createdAt) : '—'}
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
