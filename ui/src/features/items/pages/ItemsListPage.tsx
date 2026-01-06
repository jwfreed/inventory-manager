import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useItemsList } from '../queries'
import { useInventorySnapshotSummary } from '../../inventory/queries'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { formatDate, formatNumber } from '@shared/formatters'
import { ItemForm } from '../components/ItemForm'

const lifecycleStatusOptions = [
  { label: 'All', value: '' },
  { label: 'Active', value: 'Active' },
  { label: 'Inactive', value: 'Obsolete,Phase-Out' },
]

const abcClassOptions = [
  { label: 'All', value: '' },
  { label: 'Class A', value: 'A' },
  { label: 'Class B', value: 'B' },
  { label: 'Class C', value: 'C' },
]

const typeLabels: Record<string, string> = {
  raw: 'Raw',
  wip: 'WIP',
  finished: 'Finished',
  packaging: 'Packaging',
}

export default function ItemsListPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  
  const [lifecycleStatus, setLifecycleStatus] = useState('Active')
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [typeFilter, setTypeFilter] = useState('')
  const [abcClassFilter, setAbcClassFilter] = useState(searchParams.get('abcClass') || '')
  const createSectionRef = useRef<HTMLDivElement | null>(null)

  // Sync ABC class from URL params on mount
  useEffect(() => {
    const abcParam = searchParams.get('abcClass')
    if (abcParam) {
      setAbcClassFilter(abcParam)
    }
  }, [searchParams])

  const { data, isLoading, isError, error, refetch } = useItemsList({
    lifecycleStatus: lifecycleStatus,
  })

  const snapshotSummaryQuery = useInventorySnapshotSummary(
    {
      limit: data?.data?.length ? Math.max(data.data.length, 200) : 200,
    },
    { enabled: Boolean(data?.data?.length) },
  )

  const filtered = useMemo(() => {
    const list = data?.data ?? []
    if (!search) return list
    const needle = search.toLowerCase()
    return list.filter(
      (item) =>
        item.sku.toLowerCase().includes(needle) || item.name.toLowerCase().includes(needle),
    )
  }, [data?.data, search])

  const filteredByType = useMemo(() => {
    if (!typeFilter && !abcClassFilter) return filtered
    let result = filtered
    if (typeFilter) {
      result = result.filter((item) => item.type === typeFilter)
    }
    if (abcClassFilter) {
      result = result.filter((item) => item.abcClass === abcClassFilter)
    }
    return result
  }, [filtered, typeFilter, abcClassFilter])

  const availableByItem = useMemo(() => {
    const map = new Map<string, Map<string, number>>()
    ;(snapshotSummaryQuery.data ?? []).forEach((row) => {
      const itemMap = map.get(row.itemId) ?? new Map<string, number>()
      itemMap.set(row.uom, (itemMap.get(row.uom) ?? 0) + row.available)
      map.set(row.itemId, itemMap)
    })
    return map
  }, [snapshotSummaryQuery.data])

  useEffect(() => {
    if (!showCreate) return
    if (!createSectionRef.current) return
    createSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [showCreate])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Master data</p>
          <h2 className="text-2xl font-semibold text-slate-900">Items</h2>
          <p className="max-w-3xl text-sm text-slate-600">
            Browse items or add new ones. Use filters to narrow the list.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          New item
        </Button>
      </div>

      {showCreate && (
        <Section title="Create item">
          <div ref={createSectionRef} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <ItemForm
              autoFocusSku
              onCancel={() => setShowCreate(false)}
              onSuccess={(item) => {
                setShowCreate(false)
                void refetch()
                navigate(`/items/${item.id}`)
              }}
            />
          </div>
        </Section>
      )}

      <Section title="Filters">
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={lifecycleStatus}
            onChange={(e) => setLifecycleStatus(e.target.value)}
          >
            {lifecycleStatusOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <select
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="">All types</option>
            {Object.entries(typeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={abcClassFilter}
            onChange={(e) => setAbcClassFilter(e.target.value)}
          >
            {abcClassOptions.map((opt) => (
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
        </div>
        <div className="pt-2 text-sm text-slate-600">
          Showing {filteredByType.length} of {data?.data?.length ?? 0} items
        </div>
      </Section>

      <Section title="Items">
        <Card className={showCreate ? 'opacity-80' : undefined}>
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
          {!isLoading && !isError && filteredByType.length === 0 && (
            <EmptyState
              title="No items yet"
              description="Create items with the form above or via API/migrations."
            />
          )}
          {!isLoading && !isError && filteredByType.length > 0 && (
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
                      Available
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      ABC
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Created
                    </th>
                    {/* TODO: Add a lightweight operational signal (last movement / has stock) when a cheap endpoint exists. */}
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <span className="sr-only">Details</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {filteredByType.map((item) => (
                    <tr
                      key={item.id}
                      className="group cursor-pointer hover:bg-slate-50"
                      onClick={() => navigate(`/items/${item.id}`)}
                    >
                      <td className="px-4 py-3 text-sm font-semibold text-slate-900">
                        <Link
                          to={`/items/${item.id}`}
                          className="text-brand-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {item.sku}
                        </Link>
                      </td>
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
                        {(() => {
                          const totals = availableByItem.get(item.id)
                          if (!totals || totals.size === 0) return '—'
                          return Array.from(totals.entries())
                            .map(([uom, qty]) => `${formatNumber(qty)} ${uom}`)
                            .join(' · ')
                        })()}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        {item.abcClass ? (
                          <Badge 
                            variant={
                              item.abcClass === 'A' 
                                ? 'success' 
                                : item.abcClass === 'B' 
                                  ? 'warning' 
                                  : 'neutral'
                            }
                          >
                            {item.abcClass}
                          </Badge>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        <Badge
                          variant={
                            item.lifecycleStatus === 'Active'
                              ? 'success'
                              : item.lifecycleStatus === 'Obsolete' ||
                                item.lifecycleStatus === 'Phase-Out'
                              ? 'danger'
                              : 'neutral'
                          }
                        >
                          {item.lifecycleStatus}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-700">
                        {item.createdAt ? formatDate(item.createdAt) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-slate-400">
                        <span className="opacity-0 transition-opacity group-hover:opacity-100">
                          ›
                        </span>
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
