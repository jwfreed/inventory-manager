import { useQuery } from '@tanstack/react-query'
import { listKpiRuns, listKpiSnapshots } from '../../../api/endpoints/kpis'
import type { ApiError } from '../../../api/types'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { Badge } from '../../../components/Badge'
import { KpiCardGrid } from '../components/KpiCardGrid'
import { SnapshotsTable } from '../components/SnapshotsTable'
import { formatDateTime } from '../utils'

type SnapshotQueryResult = Awaited<ReturnType<typeof listKpiSnapshots>>
type RunQueryResult = Awaited<ReturnType<typeof listKpiRuns>>

function attemptedEndpoints(result?: SnapshotQueryResult | RunQueryResult) {
  if (!result) return []
  if ('attemptedEndpoints' in result) return result.attemptedEndpoints
  if ('attempted' in result) return result.attempted
  return []
}

export default function DashboardPage() {
  const {
    data: snapshotsResult,
    isLoading: snapshotsLoading,
    isError: snapshotsError,
    error: snapshotsErrorObj,
    refetch: refetchSnapshots,
    isFetching: snapshotsFetching,
  } = useQuery<SnapshotQueryResult, ApiError>({
    queryKey: ['kpi-snapshots'],
    queryFn: () => listKpiSnapshots({ limit: 200 }),
    staleTime: 30_000,
  })

  const {
    data: runsResult,
    isLoading: runsLoading,
    isError: runsError,
    error: runsErrorObj,
    refetch: refetchRuns,
  } = useQuery<RunQueryResult, ApiError>({
    queryKey: ['kpi-runs'],
    queryFn: () => listKpiRuns({ limit: 15 }),
    staleTime: 60_000,
  })

  const snapshotsAvailable = snapshotsResult && snapshotsResult.type === 'success'
  const snapshotList = snapshotsAvailable ? snapshotsResult.data : []
  const snapshotApiMissing = snapshotsResult?.type === 'ApiNotAvailable'
  const snapshotAttempts = attemptedEndpoints(snapshotsResult)
  const runAttempts = attemptedEndpoints(runsResult)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Dashboard</p>
        <h2 className="text-2xl font-semibold text-slate-900">Dashboard</h2>
        <p className="max-w-3xl text-sm text-slate-600">
          Read-only KPI cards and snapshots as provided by the backend. If KPI endpoints are not yet
          implemented, you will see an informational placeholder instead of an error.
        </p>
      </div>

      <Section title="KPI cards">
        <Card>
          {snapshotsLoading || snapshotsFetching ? (
            <LoadingSpinner label="Loading KPI snapshots..." />
          ) : null}
          {snapshotsError && snapshotsErrorObj ? (
            <ErrorState error={snapshotsErrorObj} onRetry={() => void refetchSnapshots()} />
          ) : null}
          {!snapshotsLoading && !snapshotsFetching && !snapshotsError && snapshotApiMissing ? (
            <EmptyState
              title="KPI API not available yet"
              description={
                snapshotAttempts.length
                  ? `Attempted endpoints: ${snapshotAttempts.join(', ')}`
                  : 'No KPI endpoints responded.'
              }
            />
          ) : null}
          {!snapshotsLoading &&
          !snapshotsFetching &&
          snapshotsAvailable &&
          snapshotList.length === 0 ? (
            <EmptyState
              title="No KPI snapshots yet."
              description="Once KPI runs publish snapshots, the latest values will appear here."
            />
          ) : null}
          {!snapshotsLoading && snapshotsAvailable && snapshotList.length > 0 ? (
            <KpiCardGrid snapshots={snapshotList} />
          ) : null}
        </Card>
      </Section>

      <Section title="Snapshots table">
        {snapshotsLoading || snapshotsFetching ? (
          <Card>
            <LoadingSpinner label="Loading KPI snapshots..." />
          </Card>
        ) : null}
        {snapshotsError && snapshotsErrorObj ? (
          <Card>
            <ErrorState error={snapshotsErrorObj} onRetry={() => void refetchSnapshots()} />
          </Card>
        ) : null}
        {!snapshotsLoading && !snapshotsFetching && snapshotApiMissing ? (
          <Card>
            <EmptyState
              title="KPI API not available yet"
              description={
                snapshotAttempts.length
                  ? `Attempted endpoints: ${snapshotAttempts.join(', ')}`
                  : 'No KPI endpoints responded.'
              }
            />
          </Card>
        ) : null}
        {!snapshotsLoading &&
        snapshotsAvailable &&
        snapshotList.length === 0 &&
        !snapshotsError ? (
          <Card>
            <EmptyState
              title="No KPI snapshots yet."
              description="Run a KPI computation job to populate snapshots."
            />
          </Card>
        ) : null}
        {snapshotsAvailable && snapshotList.length > 0 ? (
          <SnapshotsTable snapshots={snapshotList} />
        ) : null}
      </Section>

      {runsResult && runsResult.type === 'success' && runsResult.data.length > 0 && (
        <Section
          title="Recent KPI runs (if available)"
          description="Latest runs reported by the API. Status is shown as provided by the backend."
        >
          <Card>
            <div className="divide-y divide-slate-200">
              {runsResult.data.slice(0, 5).map((run) => (
                <div key={run.id || `${run.status}-${run.started_at}`} className="py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Badge variant="neutral">{run.status}</Badge>
                      {run.as_of ? (
                        <span className="text-xs text-slate-500">
                          As of {formatDateTime(run.as_of)}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs text-slate-500">
                      {run.started_at && (
                        <span className="mr-2">Started {formatDateTime(run.started_at)}</span>
                      )}
                      {run.finished_at && (
                        <span className="text-slate-500">
                          Finished {formatDateTime(run.finished_at)}
                        </span>
                      )}
                    </div>
                  </div>
                  {run.notes ? <p className="mt-2 text-sm text-slate-700">{run.notes}</p> : null}
                  {(run.window_start || run.window_end) && (
                    <p className="mt-1 text-xs text-slate-500">
                      Window {formatDateTime(run.window_start) || '—'} →{' '}
                      {formatDateTime(run.window_end) || '—'}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </Section>
      )}

      {runsResult && runsResult.type === 'ApiNotAvailable' && (
        <Section title="KPI runs">
          <Card>
            <EmptyState
              title="KPI run API not available"
              description={
                runAttempts.length
                  ? `Attempted endpoints: ${runAttempts.join(', ')}`
                  : 'No run endpoints responded.'
              }
            />
          </Card>
        </Section>
      )}

      {runsError && runsErrorObj && (
        <Section title="KPI runs">
          <Card>
            <ErrorState error={runsErrorObj} onRetry={() => void refetchRuns()} />
          </Card>
        </Section>
      )}
      {runsLoading && (
        <Section title="KPI runs">
          <Card>
            <LoadingSpinner label="Loading KPI runs..." />
          </Card>
        </Section>
      )}
    </div>
  )
}
