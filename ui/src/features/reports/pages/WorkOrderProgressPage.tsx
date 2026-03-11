import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getWorkOrderProgress } from '../api/reports'
import { useItemsList } from '../../items/queries'
import {
  ActiveFiltersSummary,
  Button,
  DataTable,
  ErrorState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  Panel,
  StatusCell,
  formatStatusLabel,
  statusTone,
} from '@shared/ui'
import { formatDate, formatNumber } from '@shared/formatters'
import type { Item } from '../../../api/types/items'
import type { ApiError } from '../../../api/types/common'
import type { FilterChip } from '@shared/ui'

export default function WorkOrderProgressPage() {
  const navigate = useNavigate()
  const [statusFilter, setStatusFilter] = useState('')
  const [itemFilter, setItemFilter] = useState('')
  const [includeCompleted, setIncludeCompleted] = useState(false)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const progressQuery = useQuery({
    queryKey: [
      'work-order-progress',
      statusFilter,
      itemFilter,
      includeCompleted,
      startDate,
      endDate,
    ],
    queryFn: () =>
      getWorkOrderProgress({
        status: statusFilter || undefined,
        itemId: itemFilter || undefined,
        includeCompleted,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        limit: 500,
      }),
    staleTime: 30_000,
  })

  const itemsQuery = useItemsList({ limit: 200 }, { staleTime: 60_000 })

  const activeFilters = useMemo<FilterChip[]>(() => {
    const chips: FilterChip[] = []
    if (statusFilter) chips.push({ key: 'status', label: 'Status', value: formatStatusLabel(statusFilter) })
    if (itemFilter) {
      const selectedItem = itemsQuery.data?.data.find((item) => item.id === itemFilter)
      chips.push({
        key: 'itemId',
        label: 'Item',
        value: selectedItem ? `${selectedItem.sku} - ${selectedItem.name}` : itemFilter,
      })
    }
    if (startDate) chips.push({ key: 'startDate', label: 'From', value: startDate })
    if (endDate) chips.push({ key: 'endDate', label: 'To', value: endDate })
    if (includeCompleted) chips.push({ key: 'includeCompleted', label: 'Scope', value: 'Include completed' })
    return chips
  }, [endDate, includeCompleted, itemFilter, itemsQuery.data?.data, startDate, statusFilter])

  const clearFilter = (key: string) => {
    if (key === 'status') setStatusFilter('')
    if (key === 'itemId') setItemFilter('')
    if (key === 'startDate') setStartDate('')
    if (key === 'endDate') setEndDate('')
    if (key === 'includeCompleted') setIncludeCompleted(false)
  }

  const resetFilters = () => {
    setStatusFilter('')
    setItemFilter('')
    setIncludeCompleted(false)
    setStartDate('')
    setEndDate('')
  }

  const exportToCsv = () => {
    if (!progressQuery.data?.data) return

    const headers = [
      'WO Number',
      'Item SKU',
      'Item Name',
      'Status',
      'Type',
      'Planned Qty',
      'Completed Qty',
      '% Complete',
      'Due Date',
      'Days Until Due',
      'Late?',
    ]
    const rows = progressQuery.data.data.map((row) => [
      row.workOrderNumber,
      row.itemSku,
      row.itemName,
      row.status,
      row.orderType,
      row.quantityPlanned,
      row.quantityCompleted,
      row.percentComplete,
      row.dueDate || 'N/A',
      row.daysUntilDue?.toString() || 'N/A',
      row.isLate ? 'Yes' : 'No',
    ])

    const csv = [headers, ...rows].map((row) => row.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `work-order-progress-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const lateOrders = progressQuery.data?.data.filter((workOrder) => workOrder.isLate).length || 0
  const totalOrders = progressQuery.data?.data.length || 0
  const onTimeRate =
    totalOrders > 0 ? Math.round(((totalOrders - lateOrders) / totalOrders) * 100) : 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Work Order Progress"
        subtitle="Track completion status, lateness, and production progress without leaving the report flow."
      />

      {progressQuery.data ? (
        <Panel title="Summary" description="Late orders are separated from normal flow for faster triage.">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {[
              { label: 'Total orders', value: String(totalOrders) },
              { label: 'Late orders', value: String(lateOrders), tone: 'text-rose-600' },
              { label: 'On-time rate', value: `${onTimeRate}%`, tone: 'text-emerald-600' },
              { label: 'Scope', value: includeCompleted ? 'All orders' : 'Open only' },
            ].map((metric) => (
              <div key={metric.label} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {metric.label}
                </div>
                <div className={`mt-2 text-2xl font-semibold text-slate-900 ${metric.tone ?? ''}`}>
                  {metric.value}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel title="Filters" description="Scope the report by status, item, and due-date window.">
        <FilterBar
          actions={
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={resetFilters}>
                Reset
              </Button>
            </div>
          }
          summary={
            <ActiveFiltersSummary
              filters={activeFilters}
              onClearAll={resetFilters}
              onClearOne={clearFilter}
            />
          }
        >
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="min-w-[180px] rounded-xl border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="released">Released</option>
            <option value="in_progress">In progress</option>
            <option value="completed">Completed</option>
            <option value="closed">Canceled</option>
          </select>
          <select
            value={itemFilter}
            onChange={(event) => setItemFilter(event.target.value)}
            className="min-w-[220px] rounded-xl border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">All items</option>
            {itemsQuery.data?.data.map((item: Item) => (
              <option key={item.id} value={item.id}>
                {item.sku} - {item.name}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
            className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
            className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
          <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={includeCompleted}
              onChange={(event) => setIncludeCompleted(event.target.checked)}
              className="rounded border-slate-300"
            />
            Include completed
          </label>
        </FilterBar>
      </Panel>

      <Panel
        title="Work orders"
        description="Late orders are highlighted first so supervisors can investigate exceptions quickly."
        actions={
          <Button onClick={exportToCsv} variant="secondary" size="sm">
            Export CSV
          </Button>
        }
      >
        {progressQuery.isLoading ? <LoadingSpinner label="Loading report..." /> : null}
        {progressQuery.isError ? (
          <ErrorState error={progressQuery.error as unknown as ApiError} />
        ) : null}
        {progressQuery.data ? (
          <DataTable
            stickyHeader
            keyboardNavigation
            rows={[...progressQuery.data.data].sort((left, right) => Number(right.isLate) - Number(left.isLate))}
            rowKey={(row) => row.workOrderId}
            onRowClick={(row) => navigate(`/work-orders/${row.workOrderId}`)}
            onRowOpen={(row) => navigate(`/work-orders/${row.workOrderId}`)}
            getRowState={(row) => (row.isLate ? 'warning' : 'default')}
            emptyState={
              <div className="space-y-2">
                <div className="font-medium text-slate-700">No work orders match this report scope.</div>
                <button type="button" className="text-brand-700 underline" onClick={resetFilters}>
                  Clear filters
                </button>
              </div>
            }
            columns={[
              {
                id: 'workOrder',
                header: 'WO#',
                priority: 'primary',
                cell: (row) => row.workOrderNumber,
              },
              {
                id: 'item',
                header: 'Item',
                cell: (row) => (
                  <div>
                    <div className="font-medium text-slate-900">{row.itemSku}</div>
                    <div className="text-xs text-slate-500">{row.itemName}</div>
                  </div>
                ),
              },
              {
                id: 'status',
                header: 'Status',
                cell: (row) => (
                  <StatusCell
                    label={row.isLate ? 'Warning' : formatStatusLabel(row.status)}
                    tone={row.isLate ? 'warning' : statusTone(row.status)}
                    meta={row.isLate ? 'Late order' : row.orderType}
                    compact
                  />
                ),
              },
              {
                id: 'planned',
                header: 'Planned',
                align: 'right',
                cell: (row) => formatNumber(row.quantityPlanned),
              },
              {
                id: 'completed',
                header: 'Completed',
                align: 'right',
                cell: (row) => formatNumber(row.quantityCompleted),
              },
              {
                id: 'progress',
                header: '% done',
                align: 'right',
                cell: (row) => `${row.percentComplete}%`,
              },
              {
                id: 'dueDate',
                header: 'Due date',
                cell: (row) => (row.dueDate ? formatDate(row.dueDate) : '—'),
              },
              {
                id: 'daysLeft',
                header: 'Days left',
                align: 'right',
                priority: 'anomaly',
                cell: (row) => (row.daysUntilDue !== null ? row.daysUntilDue : '—'),
              },
            ]}
            rowActions={(row) => (
              <Button variant="secondary" size="sm" onClick={() => navigate(`/work-orders/${row.workOrderId}`)}>
                View
              </Button>
            )}
          />
        ) : null}
      </Panel>
    </div>
  )
}
