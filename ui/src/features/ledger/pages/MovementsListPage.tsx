import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { type MovementListParams } from '../api/ledger'
import { useMovementsList } from '../queries'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { Alert } from '../../../components/Alert'
import { MovementFilters } from '../components/MovementFilters'
import { MovementsTable } from '../components/MovementsTable'

const DEFAULT_LIMIT = 20

export default function MovementsListPage() {
  const [searchParams] = useSearchParams()
  const initialFilters = useMemo<MovementListParams>(() => {
    const itemId = searchParams.get('itemId') ?? undefined
    const locationId = searchParams.get('locationId') ?? undefined
    return { limit: DEFAULT_LIMIT, offset: 0, itemId, locationId }
  }, [searchParams])
  const [filters, setFilters] = useState<MovementListParams>(initialFilters)

  const { data, isLoading, isError, error, refetch, isFetching } = useMovementsList(filters, {
    placeholderData: (previousData) => previousData,
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Ledger</p>
        <h2 className="text-2xl font-semibold text-slate-900">Inventory movements</h2>
        <p className="max-w-3xl text-sm text-slate-600">
          Movements are the source of truth for stock changes. Filter by occurred date, type, and
          status. Item/location filters are hidden until the backend exposes them.
        </p>
      </div>

      <Section title="Filters">
        <MovementFilters
          initialFilters={filters}
          onApply={(next) => setFilters(next)}
          disabled={isFetching}
        />
        <Alert
          variant="info"
          title="Exception focus"
          message="Draft or late-posted movements and large adjustments are typical exceptions. Narrow the date range and sort by occurred date to spot them quickly."
        />
      </Section>

      <Section title="Movements">
        <Card>
          {isLoading && <LoadingSpinner label="Loading movements..." />}
          {isError && error && (
            <ErrorState
              error={error}
              onRetry={() => {
                void refetch()
              }}
            />
          )}
          {!isLoading && !isError && data && data.data.length === 0 && (
            <EmptyState
              title="No movements found"
              description="Broaden the date range or clear filters to see movement history."
            />
          )}
          {!isLoading && !isError && data && data.data.length > 0 && (
            <MovementsTable movements={data.data} />
          )}
        </Card>
      </Section>
    </div>
  )
}
