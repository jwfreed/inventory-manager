import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../api/http'
import type { ApiError } from '../api/types'
import { Alert } from '../components/Alert'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import { LoadingSpinner } from '../components/Loading'
import { Section } from '../components/Section'
import { Table } from '../components/Table'

type ConnectivityResult =
  | { status: 'ok'; message: string }
  | { status: 'neutral'; message: string }
  | { status: 'down'; message: string }

async function fetchConnectivity(): Promise<ConnectivityResult> {
  try {
    // Use a real endpoint that exists in the backend route table.
    // Any 200 response counts as "reachable" (even if the dataset is empty).
    await apiGet<{ data?: unknown[] }>('/vendors')
    return { status: 'ok', message: 'API responded successfully.' }
  } catch (error) {
    const apiError = error as ApiError
    if (apiError?.status === 0) {
      return {
        status: 'down',
        message:
          'Could not reach the API over the network. Ensure the backend is running and the Vite proxy is active.',
      }
    }
    if (apiError?.status === 404) {
      return {
        status: 'neutral',
        message: 'Connectivity check endpoint not available; API may still be reachable. Try Ledger.',
      }
    }
    if (apiError?.status >= 500) {
      return {
        status: 'neutral',
        message:
          'API responded, but returned a server error. This often means the database is not configured/migrated yet.',
      }
    }
    return {
      status: 'neutral',
      message: 'API responded with an error. Try opening Ledger for a more specific request.',
    }
  }
}

export default function HomePage() {
  const {
    data: connectivity,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<ConnectivityResult, ApiError>({
    queryKey: ['healthcheck'],
    queryFn: fetchConnectivity,
    retry: false,
  })

  const apiStatus = useMemo(() => {
    if (isLoading) return 'checking'
    if (isError) return 'down'
    return connectivity?.status || 'ok'
  }, [isError, isLoading, connectivity])

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
            <Alert
              variant="error"
              title="API unreachable"
              message={error.message || 'Unable to reach API.'}
              action={
                <Button size="sm" variant="secondary" onClick={() => void refetch()}>
                  Retry
                </Button>
              }
            />
          )}
          {!isLoading && !isError && (
            <Alert
              variant={apiStatus === 'ok' ? 'success' : apiStatus === 'down' ? 'error' : 'info'}
              title={
                apiStatus === 'ok'
                  ? 'API reachable'
                  : apiStatus === 'down'
                    ? 'API unreachable'
                    : 'Connectivity check'
              }
              message={connectivity?.message || 'Connectivity check completed.'}
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
