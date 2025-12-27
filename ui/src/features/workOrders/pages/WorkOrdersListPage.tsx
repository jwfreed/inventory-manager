import { useState } from 'react'
import { useItemsList } from '../../items/queries'
import { useWorkOrdersList } from '../queries'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { useNavigate } from 'react-router-dom'
import { WorkOrdersFilters } from '../components/WorkOrdersFilters'
import { WorkOrdersTable } from '../components/WorkOrdersTable'
import { useWorkOrdersListData } from '../hooks/useWorkOrdersListData'

export default function WorkOrdersListPage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')

  const itemsQuery = useItemsList({ limit: 500 }, { staleTime: 60_000 })

  const { data, isLoading, isError, error, refetch, isFetching } = useWorkOrdersList({
    status: status || undefined,
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
        <p className="max-w-3xl text-sm text-slate-600">
          Drafts do not affect inventory. Posting issues creates issue movements; posting completions creates receive movements.
        </p>
        <div>
          <Button size="sm" onClick={() => navigate('/work-orders/new')}>
            New work order
          </Button>
        </div>
      </div>

      <WorkOrdersFilters
        status={status}
        search={search}
        isFetching={isFetching}
        onStatusChange={setStatus}
        onSearchChange={setSearch}
        onRefresh={() => void refetch()}
      />

      <Section title="Work orders">
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
              description="Adjust filters or create a work order via API."
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
