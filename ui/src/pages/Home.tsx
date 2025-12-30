import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../api/http'
import type { ApiError } from '../api/types'
import { Alert } from '../components/Alert'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { LoadingSpinner } from '../components/Loading'
import { Section } from '../components/Section'
import { useAuth } from '../shared/auth'

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
  const { user, tenant, role } = useAuth()
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
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Home</p>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-2xl font-semibold text-slate-900">Home</h2>
          {role && <Badge variant="info">{role}</Badge>}
        </div>
        <p className="max-w-3xl text-sm text-slate-600">Your work today.</p>
        {(user?.email || tenant?.name || tenant?.slug) && (
          <div className="text-xs text-slate-500">
            Signed in as {user?.fullName || user?.email || 'user'} · Tenant {tenant?.name || tenant?.slug || '—'}
          </div>
        )}
      </div>

      <Section title="Needs attention" description="Short list of next steps that are likely time-sensitive.">
        {/* TODO: Add lightweight counts for QC / PO drafts when cheap endpoints exist. */}
        <Card>
          <div className="text-sm text-slate-700">Nothing urgent right now.</div>
        </Card>
      </Section>

      <Section title="Start work" description="Pick the next action and keep the flow moving.">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card title="Receive inbound" description="Record receipts, QC, and putaway.">
            <Link to="/receiving">
              <Button size="sm">Start receiving</Button>
            </Link>
          </Card>
          <Card title="Submit purchase orders" description="Create or review open POs.">
            <div className="flex gap-2">
              <Link to="/purchase-orders/new">
                <Button size="sm">Create PO</Button>
              </Link>
              <Link to="/purchase-orders">
                <Button size="sm" variant="secondary">
                  Review POs
                </Button>
              </Link>
            </div>
          </Card>
          <Card title="Review items & stock" description="Browse items and their on-hand view.">
            <Link to="/items">
              <Button size="sm" variant="secondary">
                Open items
              </Button>
            </Link>
          </Card>
          <Card title="Explain stock changes" description="Audit inventory movements by date and type.">
            <Link to="/movements">
              <Button size="sm" variant="secondary">
                View ledger
              </Button>
            </Link>
          </Card>
        </div>
      </Section>

      {apiStatus !== 'ok' && (
        <Section title="System connectivity" description="Only shown when the API is unhealthy.">
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
                variant={apiStatus === 'down' ? 'error' : 'info'}
                title={apiStatus === 'down' ? 'API unreachable' : 'Connectivity check'}
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
      )}
    </div>
  )
}
