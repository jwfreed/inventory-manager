import { useState } from 'react'
import { useItemsList } from '@features/items/queries'
import { useWorkOrdersList } from '../queries'
import { Alert, Button, Card, EmptyState, LoadingSpinner, Section } from '@shared/ui'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { WorkOrdersFilters } from '../components/WorkOrdersFilters'
import { WorkOrdersTable } from '../components/WorkOrdersTable'
import { useWorkOrdersListData } from '../hooks/useWorkOrdersListData'

export default function WorkOrdersListPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  
  const [status, setStatus] = useState(() => searchParams.get('status') || '')
  const [search, setSearch] = useState('')
  const [plannedDate, setPlannedDate] = useState('')
  const [kind, setKind] = useState('')

  const itemsQuery = useItemsList({ limit: 500 }, { staleTime: 60_000 })

  const plannedFrom = plannedDate ? `${plannedDate}T00:00:00` : undefined
  const plannedTo = plannedDate ? `${plannedDate}T23:59:59.999` : undefined

  const { data, isLoading, isError, error, refetch, isFetching } = useWorkOrdersList({
    status: status || undefined,
    kind: kind || undefined,
    plannedFrom,
    plannedTo,
    limit: 50,
  })

  const { filtered, remaining, formatOutput } = useWorkOrdersListData(
    data?.data ?? [],
    itemsQuery.data?.data ?? [],
    search,
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Execution</p>
        <h2 className="text-2xl font-semibold text-slate-900">Work Orders</h2>
        <div className="max-w-3xl space-y-1 text-sm text-slate-600">
          <p>Drafts do not affect inventory.</p>
          <p>Posting issues creates issue movements; posting completions creates receive movements.</p>
        </div>
        <div>
          <Button size="sm" onClick={() => navigate('/work-orders/new')}>
            New work order
          </Button>
        </div>
      </div>

      <WorkOrdersFilters
        status={status}
        search={search}
        plannedDate={plannedDate}
        kind={kind}
        isFetching={isFetching}
        onStatusChange={setStatus}
        onSearchChange={setSearch}
        onPlannedDateChange={setPlannedDate}
        onKindChange={setKind}
        onRefresh={() => void refetch()}
      />

      <Section title="Work orders">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
          <div>
            Showing {filtered.length} work orders
            {(status || search || plannedDate || kind) ? ' (filtered)' : ''}
          </div>
          {isFetching && <span className="text-xs uppercase tracking-wide text-slate-400">Updating…</span>}
        </div>
        <Card>
          {isLoading && <LoadingSpinner label="Loading work orders..." />}
          {isError && error && (
            <Alert
              variant="error"
              title="Failed to load work orders"
              message={error.message}
              action={
                <Button size="sm" variant="secondary" onClick={() => void refetch()}>
                  Retry
                </Button>
              }
            />
          )}
          {!isLoading && !isError && filtered.length === 0 && (
            <EmptyState
              title="No work orders found"
              description="Adjust filters or create a new work order."
            />
          )}
          {!isLoading && !isError && filtered.length > 0 && (
            <WorkOrdersTable
              rows={filtered}
              onSelect={(row) => navigate(`/work-orders/${row.id}`)}
              formatOutput={formatOutput}
              remaining={remaining}
            />
          )}
        </Card>
      </Section>
    </div>
  )
}
