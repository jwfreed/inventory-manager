import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useItemsList, useItemsMetrics } from '../queries'
import { useInventorySnapshotSummary } from '../../inventory/queries'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { formatDate, formatNumber } from '@shared/formatters'
import { useAuth } from '../../../lib/useAuth'
import type { Item } from '../../../api/types'
import type { ItemMetrics } from '../api/items'
import { ItemForm } from '../components/ItemForm'
import { useOnboarding } from '@features/onboarding/hooks'
import OnboardingTip from '@features/onboarding/components/OnboardingTip'
import { isTipDismissed, markTipDismissed } from '@features/onboarding/state'
import { trackOnboardingEvent } from '@features/onboarding/analytics'

type ColumnId =
  | 'sku'
  | 'name'
  | 'type'
  | 'defaultUom'
  | 'defaultLocation'
  | 'available'
  | 'abcClass'
  | 'status'
  | 'standardCostBase'
  | 'turns'
  | 'doi'
  | 'fillRate'
  | 'stockoutRate'
  | 'lastCount'
  | 'variance'
  | 'createdAt'
  | 'details'

type ColumnDefinition = {
  id: ColumnId
  label: string
  header?: ReactNode
  optional?: boolean
  align?: 'left' | 'right'
  headerClassName?: string
  cellClassName?: string
  render: (item: Item) => ReactNode
}

const BASE_COLUMN_IDS: ColumnId[] = [
  'sku',
  'name',
  'type',
  'available',
  'abcClass',
  'status',
  'details',
]

const OPTIONAL_COLUMN_IDS: ColumnId[] = [
  'defaultUom',
  'defaultLocation',
  'standardCostBase',
  'turns',
  'doi',
  'fillRate',
  'stockoutRate',
  'lastCount',
  'variance',
  'createdAt',
]

const METRICS_COLUMN_IDS: ColumnId[] = [
  'turns',
  'doi',
  'fillRate',
  'stockoutRate',
  'lastCount',
  'variance',
]

const COLUMN_STORAGE_KEY = 'items-list-columns-v1'

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

  const { user } = useAuth()
  const { progress, markTipShown } = useOnboarding()
  const baseCurrency = user?.baseCurrency ?? 'THB'

  const [lifecycleStatus, setLifecycleStatus] = useState('Active')
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [typeFilter, setTypeFilter] = useState('')
  const [abcClassFilter, setAbcClassFilter] = useState(searchParams.get('abcClass') || '')
  const [showColumnSelector, setShowColumnSelector] = useState(false)
  const [visibleOptionalColumns, setVisibleOptionalColumns] = useState<ColumnId[]>(() => {
    if (typeof window === 'undefined') return []
    const stored = window.localStorage.getItem(COLUMN_STORAGE_KEY)
    if (!stored) return []
    try {
      const parsed = JSON.parse(stored)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((id: unknown): id is ColumnId =>
        typeof id === 'string' && OPTIONAL_COLUMN_IDS.includes(id as ColumnId),
      )
    } catch {
      return []
    }
  })
  const createSectionRef = useRef<HTMLDivElement | null>(null)
  const columnButtonRef = useRef<HTMLButtonElement | null>(null)
  const columnPanelRef = useRef<HTMLDivElement | null>(null)
  const firstColumnCheckboxRef = useRef<HTMLInputElement | null>(null)
  const columnPanelId = 'items-columns-panel'

  // Sync ABC class from URL params on mount
  useEffect(() => {
    const abcParam = searchParams.get('abcClass')
    if (abcParam) {
      setAbcClassFilter(abcParam)
    }
  }, [searchParams])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(visibleOptionalColumns))
  }, [visibleOptionalColumns])

  const closeColumnSelector = useCallback((returnFocus = true) => {
    setShowColumnSelector(false)
    if (!returnFocus || typeof window === 'undefined') return
    window.requestAnimationFrame(() => columnButtonRef.current?.focus())
  }, [])

  useEffect(() => {
    if (!showColumnSelector || typeof window === 'undefined') return
    const focusId = window.requestAnimationFrame(() => {
      firstColumnCheckboxRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(focusId)
  }, [showColumnSelector])

  useEffect(() => {
    if (!showColumnSelector || typeof document === 'undefined') return

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (columnPanelRef.current?.contains(target) || columnButtonRef.current?.contains(target)) {
        return
      }
      closeColumnSelector()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeColumnSelector()
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeColumnSelector, showColumnSelector])

  const { data, isLoading, isError, error, refetch } = useItemsList({
    lifecycleStatus: lifecycleStatus,
  })

  const shouldShowBulkEditTip =
    (data?.data?.length ?? 0) >= 3 &&
    !progress.tipsShown['bulk_edit'] &&
    !isTipDismissed('bulk_edit')

  useEffect(() => {
    if (!shouldShowBulkEditTip) return
    markTipShown('bulk_edit')
    trackOnboardingEvent('onboarding_tip_shown', {
      step_name: 'tips',
      step_index: 0,
      timestamp: new Date().toISOString(),
      event: 'bulk_edit',
      user_role: progress.userRole ?? null,
      business_type: progress.businessType ?? null,
      path_chosen: progress.pathChosen ?? null,
    })
  }, [markTipShown, progress, shouldShowBulkEditTip])

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
      const key = row.uom
      itemMap.set(key, (itemMap.get(key) ?? 0) + row.available)
      map.set(row.itemId, itemMap)
    })
    return map
  }, [snapshotSummaryQuery.data])

  const itemIds = useMemo(() => filteredByType.map((item) => item.id), [filteredByType])
  const metricsEnabled = visibleOptionalColumns.some((columnId) =>
    METRICS_COLUMN_IDS.includes(columnId),
  )
  const metricsQuery = useItemsMetrics(itemIds, 90, {
    enabled: metricsEnabled,
  })
  const metricsByItem = useMemo(() => {
    const map = new Map<string, ItemMetrics>()
    ;(metricsQuery.data ?? []).forEach((metric) => {
      map.set(metric.itemId, metric)
    })
    return map
  }, [metricsQuery.data])
  const metricsStatus = metricsEnabled
    ? metricsQuery.isLoading
      ? 'loading'
      : metricsQuery.isError
        ? 'error'
        : 'ready'
    : 'disabled'

  const toggleOptionalColumn = (columnId: ColumnId) => {
    setVisibleOptionalColumns((prev) =>
      prev.includes(columnId) ? prev.filter((id) => id !== columnId) : [...prev, columnId],
    )
  }

  const handleColumnToggle = () => {
    setShowColumnSelector((prev) => !prev)
  }

  const columns = useMemo<ColumnDefinition[]>(() => {
    const renderMetricValue = (value: number | null, formatter: (val: number) => string) => {
      if (metricsStatus === 'loading') return '...'
      if (metricsStatus !== 'ready') return '—'
      if (value === null || value === undefined) return '—'
      return formatter(value)
    }

    const renderMetricDate = (value: string | null) => {
      if (metricsStatus === 'loading') return '...'
      if (metricsStatus !== 'ready') return '—'
      return value ? formatDate(value) : '—'
    }

    return [
      {
        id: 'sku',
        label: 'SKU',
        cellClassName: 'font-semibold text-slate-900',
        render: (item) => (
          <Link
            to={`/items/${item.id}`}
            className="text-brand-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            onClick={(event) => event.stopPropagation()}
          >
            {item.sku}
          </Link>
        ),
      },
      {
        id: 'name',
        label: 'Name',
        render: (item) => item.name,
      },
      {
        id: 'type',
        label: 'Type',
        render: (item) => <Badge variant="neutral">{typeLabels[item.type] ?? item.type}</Badge>,
      },
      {
        id: 'defaultUom',
        label: 'Default UOM',
        optional: true,
        render: (item) => item.defaultUom || '—',
      },
      {
        id: 'defaultLocation',
        label: 'Default location',
        optional: true,
        render: (item) => item.defaultLocationCode || item.defaultLocationName || '—',
      },
      {
        id: 'available',
        label: 'Available (on-hand − reservations)',
        render: (item) => {
          const totals = availableByItem.get(item.id)
          if (!totals || totals.size === 0) return '—'
          return Array.from(totals.entries())
            .map(([key, qty]) => {
              return `${formatNumber(qty)} ${key}`
            })
            .join(' · ')
        },
      },
      {
        id: 'abcClass',
        label: 'ABC',
        render: (item) =>
          item.abcClass ? (
            <Badge
              variant={
                item.abcClass === 'A' ? 'success' : item.abcClass === 'B' ? 'warning' : 'neutral'
              }
            >
              {item.abcClass}
            </Badge>
          ) : (
            '—'
          ),
      },
      {
        id: 'status',
        label: 'Status',
        render: (item) => (
          <Badge
            variant={
              item.lifecycleStatus === 'Active'
                ? 'success'
                : item.lifecycleStatus === 'Obsolete' || item.lifecycleStatus === 'Phase-Out'
                  ? 'danger'
                  : 'neutral'
            }
          >
            {item.lifecycleStatus}
          </Badge>
        ),
      },
      {
        id: 'standardCostBase',
        label: `Std cost (${baseCurrency})`,
        optional: true,
        align: 'right',
        render: (item) =>
          item.standardCostBase != null ? formatNumber(item.standardCostBase) : '—',
      },
      {
        id: 'turns',
        label: 'Turns',
        optional: true,
        align: 'right',
        render: (item) => {
          const metric = metricsByItem.get(item.id)
          return renderMetricValue(metric?.turns ?? null, (value) => value.toFixed(2))
        },
      },
      {
        id: 'doi',
        label: 'DOI',
        optional: true,
        align: 'right',
        render: (item) => {
          const metric = metricsByItem.get(item.id)
          return renderMetricValue(metric?.doiDays ?? null, (value) => `${value.toFixed(1)} d`)
        },
      },
      {
        id: 'fillRate',
        label: 'Fill rate',
        optional: true,
        align: 'right',
        render: (item) => {
          const metric = metricsByItem.get(item.id)
          return renderMetricValue(metric?.fillRate ?? null, (value) => `${(value * 100).toFixed(1)}%`)
        },
      },
      {
        id: 'stockoutRate',
        label: 'Stockout',
        optional: true,
        align: 'right',
        render: (item) => {
          const metric = metricsByItem.get(item.id)
          return renderMetricValue(
            metric?.stockoutRate ?? null,
            (value) => `${(value * 100).toFixed(1)}%`,
          )
        },
      },
      {
        id: 'lastCount',
        label: 'Last count',
        optional: true,
        render: (item) => {
          const metric = metricsByItem.get(item.id)
          return renderMetricDate(metric?.lastCountAt ?? null)
        },
      },
      {
        id: 'variance',
        label: 'Variance',
        optional: true,
        render: (item) => {
          if (metricsStatus === 'loading') return '...'
          if (metricsStatus !== 'ready') return '—'
          const metric = metricsByItem.get(item.id)
          const varianceQty = metric?.lastCountVarianceQty ?? null
          const variancePct = metric?.lastCountVariancePct ?? null
          if (varianceQty === null && variancePct === null) return '—'
          const qtyLabel = varianceQty !== null ? formatNumber(varianceQty) : '0'
          if (variancePct === null) return qtyLabel
          return `${qtyLabel} (${(variancePct * 100).toFixed(1)}%)`
        },
      },
      {
        id: 'createdAt',
        label: 'Created',
        optional: true,
        render: (item) => (item.createdAt ? formatDate(item.createdAt) : '—'),
      },
      {
        id: 'details',
        label: 'Details',
        header: <span className="sr-only">Details</span>,
        align: 'right',
        cellClassName: 'text-slate-400',
        render: () => (
          <span className="opacity-0 transition-opacity group-hover:opacity-100">›</span>
        ),
      },
    ]
  }, [availableByItem, baseCurrency, metricsByItem, metricsStatus])

  const visibleColumns = useMemo(
    () =>
      columns.filter(
        (column) =>
          BASE_COLUMN_IDS.includes(column.id) || visibleOptionalColumns.includes(column.id),
      ),
    [columns, visibleOptionalColumns],
  )

  const optionalColumns = useMemo(
    () => columns.filter((column) => column.optional),
    [columns],
  )

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
          <div className="relative">
            <Button
              ref={columnButtonRef}
              size="sm"
              variant="secondary"
              aria-expanded={showColumnSelector}
              aria-controls={columnPanelId}
              className={
                showColumnSelector
                  ? 'border-slate-300 bg-slate-100 text-slate-900'
                  : undefined
              }
              onClick={handleColumnToggle}
            >
              Columns
              <span className="ml-1 text-xs" aria-hidden="true">
                {showColumnSelector ? '▴' : '▾'}
              </span>
            </Button>
            {showColumnSelector && (
              <div
                ref={columnPanelRef}
                id={columnPanelId}
                role="region"
                aria-label="Columns"
                className="absolute left-0 z-20 mt-2 w-64 rounded-lg border border-slate-200 bg-white p-3 shadow-lg"
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Optional columns
                </div>
                <div className="mt-2 grid gap-2">
                  {optionalColumns.map((column, index) => (
                    <label key={column.id} className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        ref={index === 0 ? firstColumnCheckboxRef : undefined}
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        checked={visibleOptionalColumns.includes(column.id)}
                        onChange={() => toggleOptionalColumn(column.id)}
                      />
                      <span>{column.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="pt-2 text-sm text-slate-600">
          Showing {filteredByType.length} of {data?.data?.length ?? 0} items
        </div>
      </Section>

      <Section title="Items">
        {shouldShowBulkEditTip && (
          <OnboardingTip
            title="Tip: bulk edit"
            message="Select multiple items to update fields in one pass."
            onDismiss={() => {
              markTipDismissed('bulk_edit')
              markTipShown('bulk_edit')
              trackOnboardingEvent('onboarding_tip_dismissed', {
                step_name: 'tips',
                step_index: 0,
                timestamp: new Date().toISOString(),
                event: 'bulk_edit',
                user_role: progress.userRole ?? null,
                business_type: progress.businessType ?? null,
                path_chosen: progress.pathChosen ?? null,
              })
            }}
          />
        )}
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
              description="Add your first item to start tracking inventory."
              action={
                <Button size="sm" onClick={() => navigate('/onboarding/first-win')}>
                  Add your first item
                </Button>
              }
            />
          )}
          {!isLoading && !isError && filteredByType.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    {visibleColumns.map((column) => {
                      const alignClass = column.align === 'right' ? 'text-right' : 'text-left'
                      return (
                        <th
                          key={column.id}
                          className={`px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 ${alignClass} ${column.headerClassName ?? ''}`}
                        >
                          {column.header ?? column.label}
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {filteredByType.map((item) => (
                    <tr
                      key={item.id}
                      className="group cursor-pointer hover:bg-slate-50"
                      onClick={() => navigate(`/items/${item.id}`)}
                    >
                      {visibleColumns.map((column) => {
                        const alignClass = column.align === 'right' ? 'text-right' : 'text-left'
                        return (
                          <td
                            key={column.id}
                            className={`px-4 py-3 text-sm text-slate-800 ${alignClass} ${column.cellClassName ?? ''}`}
                          >
                            {column.render(item)}
                          </td>
                        )
                      })}
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
