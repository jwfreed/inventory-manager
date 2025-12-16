import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../api/http'
import type { ApiError } from '../api/types'
import { Alert } from '../components/Alert'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { LoadingSpinner } from '../components/Loading'
import { Section } from '../components/Section'
import { Table } from '../components/Table'

type HealthResponse = { status?: string; message?: string }

const healthEndpoints = ['/api/health', '/api']

async function fetchHealth(): Promise<HealthResponse> {
  let lastError: ApiError | undefined
  // Try health endpoints in order, stop on first success.
  for (const path of healthEndpoints) {
    try {
      return await apiGet<HealthResponse>(path)
    } catch (error) {
      lastError = error as ApiError
    }
  }

  throw lastError ?? { status: 500, message: 'Unable to reach API' }
}

export default function HomePage() {
  const {
    data: health,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<HealthResponse, ApiError>({
    queryKey: ['healthcheck'],
    queryFn: fetchHealth,
    retry: false,
  })

  const apiStatus = useMemo(() => {
    if (isLoading) return 'checking'
    if (isError) return 'down'
    return health?.status || 'ok'
  }, [isError, isLoading, health])

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Foundation</p>
        <h2 className="text-2xl font-semibold text-slate-900">Welcome to the Inventory UI</h2>
        <p className="max-w-3xl text-sm text-slate-600">
          Phase A focuses on a sturdy shell: consistent layout, routing, API plumbing, and a small
          component kit. Domain screens will plug into this in later phases.
        </p>
      </div>

      <Section title="API connectivity" description="Quick reachability check to the backend.">
        <Card>
          {isLoading && <LoadingSpinner label="Checking API..." />}
          {isError && error && (
            <ErrorState
              error={error}
              onRetry={() => {
                void refetch()
              }}
            />
          )}
          {!isLoading && !isError && (
            <Alert
              variant={apiStatus === 'ok' ? 'success' : 'warning'}
              title={apiStatus === 'ok' ? 'API reachable' : 'API status'}
              message={health?.message || 'Health endpoint responded successfully.'}
              action={
                <Button size="sm" variant="secondary" onClick={() => void refetch()}>
                  Recheck
                </Button>
              }
            />
          )}
        </Card>
      </Section>

      <Section
        title="Design system primer"
        description="A minimal set of reusable pieces to keep early pages consistent."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Card
            title="Empty state"
            description="Use when a dataset has no results or a feature is upcoming."
          >
            <EmptyState
              title="Nothing here yet"
              description="Future inventory and work order views will live here."
              action={<Button disabled>Configure source</Button>}
            />
          </Card>

          <Card title="Table" description="Simple table with stubbed pagination controls.">
            <Table
              columns={[
                { header: 'Name', accessor: 'name' },
                { header: 'Status', accessor: 'status' },
                { header: 'Owner', accessor: 'owner' },
              ]}
              data={[
                { name: 'Placeholder row', status: 'Draft', owner: 'Ops' },
                { name: 'Another row', status: 'Planned', owner: 'Manufacturing' },
              ]}
              pagination={{ page: 1, pageCount: 1 }}
            />
          </Card>
        </div>
      </Section>
    </div>
  )
}
