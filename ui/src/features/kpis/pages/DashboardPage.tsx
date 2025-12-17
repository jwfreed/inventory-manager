import { useQuery } from '@tanstack/react-query'
import { getFulfillmentFillRate, listKpiRuns, listKpiSnapshots } from '../../../api/endpoints/kpis'
import { listWorkOrders } from '../../../api/endpoints/workOrders'
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
import { formatNumber } from '../../../lib/formatters'

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
  const snapshotUnavailableDescription =
    snapshotAttempts.length > 0
      ? `Endpoint not available: ${snapshotAttempts.join(', ')}`
      : 'KPI runtime endpoints are not implemented in this repository (DB-first only).'
  const runUnavailableDescription =
    runAttempts.length > 0
      ? `Endpoint not available: ${runAttempts.join(', ')}`
      : 'KPI run endpoints are not implemented in this repository (DB-first only).'

  const productionQuery = useQuery({
    queryKey: ['production-summary'],
    queryFn: () => listWorkOrders({ limit: 200 }),
    staleTime: 30_000,
  })

  const fillRateQuery = useQuery({
    queryKey: ['fulfillment-fill-rate'],
    queryFn: () => getFulfillmentFillRate({}),
    staleTime: 30_000,
  })

  const productionRows =
    productionQuery.data?.data.map((wo) => ({
      outputItemId: wo.outputItemId,
      uom: wo.outputUom,
      planned: wo.quantityPlanned,
      completed: wo.quantityCompleted ?? 0,
    })) ?? []

  const productionByItem = productionRows.reduce<
    Record<string, { itemId: string; uom: string; planned: number; completed: number }>
  >((acc, row) => {
    const key = `${row.outputItemId}:${row.uom}`
    const existing = acc[key] ?? { itemId: row.outputItemId, uom: row.uom, planned: 0, completed: 0 }
    existing.planned += row.planned
    existing.completed += row.completed
    acc[key] = existing
    return acc
  }, {})

  const productionList = Object.values(productionByItem).map((val) => ({
    ...val,
    remaining: Math.max(0, val.planned - val.completed),
  }))

  const fillRateCard = (() => {
    if (fillRateQuery.isLoading) {
      return <LoadingSpinner label="Loading fulfillment fill rate..." />
    }
    if (fillRateQuery.isError && (fillRateQuery.error as ApiError)?.status === 404) {
      return (
        <EmptyState
          title="Fill rate not available"
          description="Backend did not expose /kpis/fulfillment-fill-rate. This card is a measured proxy only."
        />
      )
    }
    if (fillRateQuery.isError && fillRateQuery.error) {
      return <ErrorState error={fillRateQuery.error as ApiError} onRetry={() => void fillRateQuery.refetch()} />
    }
    return (
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-700">Fulfillment Fill Rate (measured)</p>
          <p className="text-xs text-slate-500">
            Window: {fillRateQuery.data?.window.from ?? 'all time'} → {fillRateQuery.data?.window.to ?? 'now'}
          </p>
          {fillRateQuery.data?.assumptions?.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-500">
              {fillRateQuery.data.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="text-right">
          <p className="text-3xl font-semibold text-slate-900">
            {fillRateQuery.data?.fillRate != null
              ? `${formatNumber(fillRateQuery.data.fillRate * 100, { maximumFractionDigits: 1 })}%`
              : 'n/a'}
          </p>
          <p className="text-xs text-slate-500">
            Shipped: {formatNumber(fillRateQuery.data?.shippedQty ?? 0)} / Ordered:{' '}
            {formatNumber(fillRateQuery.data?.requestedQty ?? 0)}
          </p>
        </div>
      </div>
    )
  })()

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Dashboard</p>
        <h2 className="text-2xl font-semibold text-slate-900">Dashboard</h2>
        <p className="max-w-3xl text-sm text-slate-600">
          Quick snapshot of KPIs and production progress. If a data feed is missing, you will see a
          calm placeholder instead of an error.
        </p>
      </div>

      <Section
        title="Production progress"
        description="Planned versus completed quantities by finished or intermediate item (from work orders)."
      >
        <Card>
          {productionQuery.isLoading && <LoadingSpinner label="Loading production summary..." />}
          {productionQuery.isError && productionQuery.error && (
            <ErrorState error={productionQuery.error as ApiError} onRetry={() => void productionQuery.refetch()} />
          )}
          {!productionQuery.isLoading && !productionQuery.isError && productionList.length === 0 && (
            <EmptyState
              title="No work orders found"
              description="Create work orders to see planned vs. completed quantities."
            />
          )}
          {!productionQuery.isLoading && !productionQuery.isError && productionList.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Item to make
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Planned qty
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Completed
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Remaining
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {productionList.map((row) => (
                    <tr key={`${row.itemId}-${row.uom}`}>
                      <td className="px-3 py-2 text-sm text-slate-800">{row.itemId}</td>
                      <td className="px-3 py-2 text-right text-sm text-slate-800">
                        {row.planned} {row.uom}
                      </td>
                      <td className="px-3 py-2 text-right text-sm text-slate-800">
                        {row.completed} {row.uom}
                      </td>
                      <td className="px-3 py-2 text-right text-sm text-slate-800">
                        {row.remaining} {row.uom}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Section>

      <Section
        title="Measured fulfillment"
        description="Fulfillment Fill Rate (measured) from shipped sales order lines. This is a measured proxy, not PPIS."
      >
        <Card>
          {fillRateCard}
        </Card>
      </Section>

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
              description={snapshotUnavailableDescription}
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
              description={snapshotUnavailableDescription}
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
              description={runUnavailableDescription}
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
