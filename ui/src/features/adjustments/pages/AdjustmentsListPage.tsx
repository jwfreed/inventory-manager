import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useInventoryAdjustmentsList } from '../queries'
import type { InventoryAdjustmentSummary } from '@api/types'
import { Alert, Badge, Button, Card, DataTable, LoadingSpinner, Section } from '@shared/ui'
import { formatDate, formatNumber } from '@shared/formatters'
import { usePageChrome } from '../../../app/layout/usePageChrome'

const statusOptions = [
  { label: 'All', value: '' },
  { label: 'Draft', value: 'draft' },
  { label: 'Posted', value: 'posted' },
  { label: 'Canceled', value: 'canceled' },
]

function formatTotals(row: InventoryAdjustmentSummary) {
  const totals = row.totalsByUom ?? []
  if (!totals.length) return '—'
  return totals
    .map((total) => {
      const qty = total.quantityDelta ?? 0
      const sign = qty > 0 ? '+' : qty < 0 ? '−' : ''
      return `${sign}${formatNumber(Math.abs(qty))} ${total.uom}`
    })
    .join(' · ')
}

function statusBadge(row: InventoryAdjustmentSummary) {
  if (row.status === 'posted') {
    return <Badge variant="success">{row.isCorrected ? 'Corrected' : 'Posted'}</Badge>
  }
  if (row.status === 'draft') return <Badge variant="neutral">Draft</Badge>
  if (row.status === 'canceled') return <Badge variant="danger">Canceled</Badge>
  return <Badge variant="neutral">{row.status}</Badge>
}

export default function AdjustmentsListPage() {
  const navigate = useNavigate()
  const { hideTitle } = usePageChrome()
  const [status, setStatus] = useState('')

  const { data, isLoading, isError, error, refetch } = useInventoryAdjustmentsList(
    { status: status || undefined, limit: 50, offset: 0 },
    { staleTime: 30_000 },
  )

  const rows = useMemo(() => data?.data ?? [], [data?.data])

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        {!hideTitle && <h2 className="text-2xl font-semibold text-slate-900">Inventory adjustments</h2>}
        <p className="max-w-3xl text-sm text-slate-600">
          Adjustments are append-only corrections to the movement ledger. Drafts can be edited, posted
          adjustments are immutable, and corrections are done by reversal entries.
        </p>
      </div>

      <Section title="Actions">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => navigate('/inventory-adjustments/new')}>New adjustment</Button>
          <select
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {statusOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Refresh
          </Button>
        </div>
      </Section>

      <Section title="Adjustments">
        <Card>
          {isLoading && <LoadingSpinner label="Loading adjustments..." />}
          {isError && error && (
            <Alert
              variant="error"
              title="Failed to load adjustments"
              message={error.message || 'Endpoint may be missing.'}
              action={
                <Button size="sm" variant="secondary" onClick={() => void refetch()}>
                  Retry
                </Button>
              }
            />
          )}
          {!isLoading && !isError && (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              emptyMessage="No adjustments yet."
              onRowClick={(row) => navigate(`/inventory-adjustments/${row.id}`)}
              columns={[
                {
                  id: 'status',
                  header: 'Status',
                  cell: (row) => statusBadge(row),
                },
                {
                  id: 'occurred',
                  header: 'Occurred',
                  cell: (row) => formatDate(row.occurredAt),
                },
                {
                  id: 'lines',
                  header: 'Lines',
                  align: 'right',
                  cell: (row) => row.lineCount ?? 0,
                },
                {
                  id: 'net',
                  header: 'Net delta',
                  cell: (row) => formatTotals(row),
                },
                {
                  id: 'notes',
                  header: 'Notes',
                  cell: (row) => row.notes || '—',
                },
              ]}
            />
          )}
        </Card>
      </Section>
    </div>
  )
}
