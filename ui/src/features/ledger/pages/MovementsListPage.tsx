import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listMovements, type MovementListParams } from '../../../api/endpoints/ledger'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import type { ApiError, MovementListResponse } from '../../../api/types'
import { MovementFilters } from '../components/MovementFilters'
import { MovementsTable } from '../components/MovementsTable'

const DEFAULT_PAGE_SIZE = 20

export default function MovementsListPage() {
  const [filters, setFilters] = useState<MovementListParams>({ page: 1, pageSize: DEFAULT_PAGE_SIZE })

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<
    MovementListResponse,
    ApiError
  >({
    queryKey: ['movements', filters],
    queryFn: () => listMovements(filters),
    placeholderData: (previousData) => previousData,
  })

  const pageCount = useMemo(() => {
    if (!data?.total || !data.pageSize) return undefined
    return Math.max(1, Math.ceil(data.total / data.pageSize))
  }, [data?.total, data?.pageSize])

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
            <MovementsTable
              movements={data.data}
              page={data.page}
              pageCount={pageCount}
              onPageChange={(page) => setFilters((prev) => ({ ...prev, page }))}
            />
          )}
          {!pageCount && data?.data.length ? (
            <div className="mt-2 text-xs text-slate-500">
              Pagination controls are limited until the backend exposes totals/page metadata.
            </div>
          ) : null}
        </Card>
      </Section>
    </div>
  )
}
