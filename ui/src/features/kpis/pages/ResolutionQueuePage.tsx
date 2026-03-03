import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { formatNumber } from '@shared/formatters'
import {
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingSpinner,
  PageHeader,
  Section,
  SeverityPill,
  Toggle,
} from '@shared/ui'
import { filterResolutionQueue, type DashboardExceptionType } from '../dashboardMath'
import { useDashboardSignals } from '../useDashboardSignals'

const PAGE_SIZE = 25

const queueTypeOptions: Array<{ value: DashboardExceptionType | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'availability_breach', label: 'Availability' },
  { value: 'negative_on_hand', label: 'Negative on-hand' },
  { value: 'reorder_risk', label: 'Reorder' },
  { value: 'inbound_aging', label: 'Inbound aging' },
  { value: 'work_order_risk', label: 'WO risk' },
  { value: 'cycle_count_hygiene', label: 'Cycle count' },
]

function typeLabel(type: DashboardExceptionType) {
  switch (type) {
    case 'availability_breach':
      return 'Availability breach'
    case 'negative_on_hand':
      return 'Negative on-hand'
    case 'reorder_risk':
      return 'Reorder risk'
    case 'inbound_aging':
      return 'Inbound aging'
    case 'work_order_risk':
      return 'Open WO risk'
    case 'cycle_count_hygiene':
      return 'Cycle count hygiene'
    default:
      return type
  }
}

export default function ResolutionQueuePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [page, setPage] = useState(1)
  const { data, loading, error } = useDashboardSignals()
  const selectedType = (searchParams.get('type') as DashboardExceptionType | 'all' | null) ?? 'all'
  const queueRows = useMemo(
    () => filterResolutionQueue(data.exceptions, selectedType),
    [data.exceptions, selectedType],
  )
  const pageCount = Math.max(1, Math.ceil(queueRows.length / PAGE_SIZE))
  const pagedRows = useMemo(
    () => queueRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [queueRows, page],
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Resolution Queue"
        subtitle="Single queue for inventory exceptions, sorted by severity, impact, and recency."
        meta={<p className="text-xs text-slate-500">As of {data.asOfLabel}</p>}
        action={
          <Link to="/dashboard" className="text-sm font-medium text-brand-700 hover:underline">
            Back to dashboard
          </Link>
        }
      />

      <Section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Toggle
            ariaLabel="Filter resolution queue by exception type"
            options={queueTypeOptions}
            value={selectedType}
            onChange={(value) => {
              setPage(1)
              if (value === 'all') {
                searchParams.delete('type')
              } else {
                searchParams.set('type', value)
              }
              setSearchParams(searchParams, { replace: true })
            }}
          />
          <div className="text-sm text-slate-600">
            {queueRows.length} exception{queueRows.length === 1 ? '' : 's'}
          </div>
        </div>
      </Section>

      <Section>
        <Card>
          {loading && <LoadingSpinner label="Loading resolution queue..." />}
          {!loading && error && <ErrorState error={error} />}
          {!loading && !error && queueRows.length === 0 && (
            <EmptyState
              title="All clear"
              description="No pending approvals or inventory exception breaches detected."
              action={
                <Link to="/purchase-orders/new" className="text-sm font-medium text-brand-700 hover:underline">
                  Create PO
                </Link>
              }
            />
          )}
          {!loading && !error && queueRows.length > 0 && (
            <DataTable
              rows={pagedRows}
              rowKey={(row) => row.id}
              columns={[
                {
                  id: 'severity',
                  header: 'Severity',
                  cell: (row) => <SeverityPill severity={row.severity} />,
                },
                {
                  id: 'type',
                  header: 'Exception',
                  cell: (row) => typeLabel(row.type),
                },
                {
                  id: 'item',
                  header: 'Item / SKU',
                  cell: (row) =>
                    row.itemId ? (
                      <Link to={row.primaryLink} className="font-medium text-brand-700 hover:underline">
                        {row.itemLabel}
                      </Link>
                    ) : (
                      row.itemLabel
                    ),
                },
                {
                  id: 'location',
                  header: 'Location',
                  cell: (row) => row.locationLabel,
                },
                {
                  id: 'impact',
                  header: 'Impact',
                  align: 'right',
                  cell: (row) => formatNumber(Math.round(row.impactScore * 100) / 100),
                },
                {
                  id: 'action',
                  header: 'Recommended action',
                  cell: (row) => (
                    <div className="space-y-1">
                      <p>{row.recommendedAction}</p>
                      <Link to={row.primaryLink} className="text-xs font-semibold text-brand-700 hover:underline">
                        Open related screen
                      </Link>
                    </div>
                  ),
                },
              ]}
            />
          )}
          {!loading && !error && queueRows.length > PAGE_SIZE && (
            <div className="mt-4 flex items-center justify-between text-sm">
              <span className="text-slate-500">
                Page {page} of {pageCount}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  disabled={page >= pageCount}
                  onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </Card>
      </Section>
    </div>
  )
}
