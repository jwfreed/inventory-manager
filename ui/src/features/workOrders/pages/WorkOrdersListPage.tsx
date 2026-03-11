import { useState } from 'react'
import { useItemsList } from '@features/items/queries'
import { useWorkOrdersList } from '../queries'
import { Alert, Button, EmptyState, LoadingSpinner, PageHeader, Panel } from '@shared/ui'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { WorkOrdersFilters } from '../components/WorkOrdersFilters'
import { WorkOrdersTable } from '../components/WorkOrdersTable'
import { useWorkOrdersListData } from '../hooks/useWorkOrdersListData'
import { usePageChrome } from '../../../app/layout/usePageChrome'

export default function WorkOrdersListPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { hideTitle } = usePageChrome()
  
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
      {!hideTitle && (
        <PageHeader
          title="Work Orders"
          subtitle="Drafts do not affect inventory. Posting issues and completions creates ledger movements."
          action={
            <Button size="sm" onClick={() => navigate('/work-orders/new')}>
              New work order
            </Button>
          }
        />
      )}
      {hideTitle && (
        <div>
          <Button size="sm" onClick={() => navigate('/work-orders/new')}>
            New work order
          </Button>
        </div>
      )}

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
        onReset={() => {
          setStatus('')
          setSearch('')
          setPlannedDate('')
          setKind('')
        }}
      />

      <Panel title="Execution queue" description="Prioritize active orders and resolve stalled production before due dates slip.">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
          <div>
            Showing {filtered.length} work orders
            {(status || search || plannedDate || kind) ? ' (filtered)' : ''}
          </div>
          {isFetching && <span className="text-xs uppercase tracking-wide text-slate-400">Updating…</span>}
        </div>
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
      </Panel>
    </div>
  )
}
