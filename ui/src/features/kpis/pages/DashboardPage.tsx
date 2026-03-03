import { useEffect, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { runDashboardKpis } from '../api/kpis'
import { useKpiRuns } from '../queries'
import { useAuth } from '@shared/auth'
import { formatNumber } from '@shared/formatters'
import {
  Banner,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingSpinner,
  MetricCard,
  PageHeader,
  Section,
  SectionHeader,
  SeverityPill,
  Toggle,
  Tooltip,
} from '@shared/ui'
import { useDashboardSignals } from '../useDashboardSignals'
import { filterResolutionQueue } from '../dashboardMath'
import { formatDateTime } from '../utils'

type DashboardMode = 'actionable' | 'all'

function parseRunMeta(note?: string | null) {
  if (!note) return null
  try {
    const parsed = JSON.parse(note) as { fingerprint?: string; runtimeMs?: number }
    const fingerprint = parsed.fingerprint ?? ''
    const warehouseId = typeof fingerprint === 'string' ? fingerprint.split('|')[2] : undefined
    return {
      warehouseId,
      runtimeMs: typeof parsed.runtimeMs === 'number' ? parsed.runtimeMs : undefined,
    }
  } catch {
    return null
  }
}

function rankSeverity(severity: 'info' | 'watch' | 'action' | 'critical') {
  if (severity === 'critical') return 4
  if (severity === 'action') return 3
  if (severity === 'watch') return 2
  return 1
}

function isActionableSignal(signal: {
  count: number
  severity: 'info' | 'watch' | 'action' | 'critical'
  type: string
  value?: string
}) {
  if (signal.count > 0) return true
  if (signal.severity === 'critical' || signal.severity === 'action') return true
  if (signal.type === 'fulfillment_reliability' && signal.severity !== 'info') return true
  if (signal.type === 'fulfillment_reliability' && signal.value === 'Not measurable yet') return true
  return false
}

export default function DashboardPage() {
  const { user, tenant } = useAuth()
  const { data, loading, error, queries } = useDashboardSignals()
  const runsQuery = useKpiRuns({ limit: 25 }, { staleTime: 60_000 })
  const [runToastOpen, setRunToastOpen] = useState(false)

  const modeStorageKey = useMemo(
    () => `dashboard:mode:${tenant?.id ?? 'tenant'}:${user?.id ?? 'user'}`,
    [tenant?.id, user?.id],
  )
  const [mode, setMode] = useState<DashboardMode>(() => {
    if (typeof window === 'undefined') return 'actionable'
    const stored = window.localStorage.getItem('dashboard:mode')
    return stored === 'all' ? 'all' : 'actionable'
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const existing = window.localStorage.getItem(modeStorageKey)
    if (existing === 'all' || existing === 'actionable') {
      setMode(existing)
    }
  }, [modeStorageKey])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(modeStorageKey, mode)
    window.localStorage.setItem('dashboard:mode', mode)
  }, [mode, modeStorageKey])

  const runMutation = useMutation({
    mutationFn: () =>
      runDashboardKpis({
        windowDays: 90,
        idempotencyKey: `dashboard:${tenant?.id ?? 'tenant'}:${new Date().toISOString().slice(0, 16)}`,
      }),
    onSuccess: () => {
      setRunToastOpen(true)
      void runsQuery.refetch()
      void queries.inventorySummaryQuery.refetch()
      void queries.recommendationsQuery.refetch()
      void queries.purchaseOrdersQuery.refetch()
      void queries.workOrdersQuery.refetch()
      void queries.itemMetricsQuery.refetch()
      void queries.fillRateQuery.refetch()
    },
  })

  useEffect(() => {
    if (!runToastOpen) return
    const timer = window.setTimeout(() => setRunToastOpen(false), 5000)
    return () => window.clearTimeout(timer)
  }, [runToastOpen])

  const allSignals = data.signals
  const visibleSignals = useMemo(
    () => (mode === 'actionable' ? allSignals.filter(isActionableSignal) : allSignals),
    [allSignals, mode],
  )
  const exceptionSignals = visibleSignals.filter((signal) => signal.type !== 'fulfillment_reliability')
  const allExceptionSignals = allSignals.filter((signal) => signal.type !== 'fulfillment_reliability')
  const urgentExceptions = allExceptionSignals.filter(
    (signal) => signal.count > 0 && rankSeverity(signal.severity) >= rankSeverity('action'),
  )
  const allClear = allExceptionSignals.every((signal) => signal.count === 0)

  const resolutionQueue = useMemo(() => filterResolutionQueue(data.exceptions, 'all'), [data.exceptions])
  const queuePreview = resolutionQueue.slice(0, 8)
  const allReliabilitySignal = allSignals.find((signal) => signal.type === 'fulfillment_reliability')
  const reliabilitySignals = visibleSignals.filter((signal) => signal.type === 'fulfillment_reliability')
  const showReliabilitySection =
    mode === 'all' ||
    reliabilitySignals.length > 0 ||
    allReliabilitySignal?.value === 'Not measurable yet'

  const latestRun = useMemo(() => {
    const list = runsQuery.data?.type === 'success' ? runsQuery.data.data : []
    const sorted = [...list].sort((left, right) => {
      const leftTime = new Date(left.as_of ?? left.finished_at ?? left.started_at ?? '').getTime()
      const rightTime = new Date(right.as_of ?? right.finished_at ?? right.started_at ?? '').getTime()
      return rightTime - leftTime
    })
    return sorted[0]
  }, [runsQuery.data])

  const latestRunMeta = parseRunMeta(latestRun?.notes)
  const runtimeEstimateSeconds = runMutation.data?.runtimeEstimateSeconds ??
    (latestRunMeta?.runtimeMs ? Math.max(1, Math.round(latestRunMeta.runtimeMs / 1000)) : 20)
  const lastRunTimestamp = runMutation.data?.computedAt ?? latestRun?.finished_at ?? latestRun?.started_at ?? null
  const asOfTimestamp = runMutation.data?.asOf ?? latestRun?.as_of ?? data.asOfIso
  const warehouseScope = runMutation.data?.warehouseId ?? latestRunMeta?.warehouseId ?? 'default warehouse'

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle="Management-by-exception view of inventory risk, flow reliability, and corrective actions."
        meta={
          <div className="space-y-1 text-xs text-slate-500">
            <div>As of {data.asOfLabel}</div>
            <div>Warehouse scope: {warehouseScope}</div>
          </div>
        }
        action={
          <Toggle
            ariaLabel="Dashboard signal mode"
            options={[
              { value: 'actionable', label: 'Actionable' },
              { value: 'all', label: 'All signals' },
            ]}
            value={mode}
            onChange={(value) => setMode(value)}
          />
        }
      />

      {runToastOpen && runMutation.data && (
        <Banner
          severity="info"
          title={runMutation.data.reused ? 'KPI run reused' : 'KPI run completed'}
          description={`As of ${formatDateTime(runMutation.data.asOf) || runMutation.data.asOf}. ${runMutation.data.snapshotsWritten} KPI snapshots available.`}
          action={
            <button
              type="button"
              className="text-sm font-semibold text-sky-800 hover:underline"
              onClick={() => setRunToastOpen(false)}
            >
              Dismiss
            </button>
          }
        />
      )}

      <Section>
        <SectionHeader
          title="KPI Compute"
          description="Idempotent read-only KPI compute. This process does not mutate inventory transactions."
          action={
            <Button
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending}
              aria-label="Run KPI calculations"
            >
              {runMutation.isPending ? 'Running KPI calculations…' : 'Run KPI calculations'}
            </Button>
          }
        />
        <Card>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Last run</p>
              <p className="mt-1 text-sm text-slate-800">
                {lastRunTimestamp ? formatDateTime(lastRunTimestamp) : 'No run yet'}
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">As of</p>
              <p className="mt-1 text-sm text-slate-800">{formatDateTime(asOfTimestamp) || asOfTimestamp}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Runtime estimate</p>
              <p className="mt-1 text-sm text-slate-800">Typically under {runtimeEstimateSeconds} seconds</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Workspace scope</p>
              <p className="mt-1 text-sm text-slate-800">{tenant?.name ?? tenant?.slug ?? 'Current workspace'}</p>
            </div>
          </div>
          {runMutation.isPending && (
            <div className="mt-3">
              <LoadingSpinner label="Computing KPI snapshots..." />
            </div>
          )}
          {runMutation.isError && (
            <div className="mt-3">
              <Banner
                severity="critical"
                title="KPI run failed"
                description="Retry KPI compute. Inventory transactions were not modified."
              />
            </div>
          )}
        </Card>
      </Section>

      <Section>
        <div
          className={[
            'space-y-3 rounded-xl border p-4',
            urgentExceptions.length > 0 ? 'border-rose-300 bg-rose-50/60' : 'border-slate-200 bg-white',
          ].join(' ')}
        >
          <SectionHeader
            title="Attention Required"
            description="Actionable exceptions only, ranked by severity and impact."
            action={
              urgentExceptions.length > 0 ? (
                <Link to="/dashboard/resolution-queue" className="text-sm font-semibold text-rose-700 hover:underline">
                  Resolve all
                </Link>
              ) : null
            }
          />
          {loading && <LoadingSpinner label="Loading dashboard signals..." />}
          {!loading && error && <ErrorState error={error} />}
          {!loading && !error && allClear && (
            <Banner
              severity="info"
              title="All clear"
              description="No pending approvals or exception breaches detected."
              action={
                <div className="flex items-center gap-3 text-sm">
                  <Link to="/purchase-orders/new" className="font-semibold text-sky-800 hover:underline">
                    Create PO
                  </Link>
                  <Link to="/items" className="font-semibold text-sky-800 hover:underline">
                    Browse items
                  </Link>
                </div>
              }
            />
          )}
          {!loading && !error && !allClear && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {exceptionSignals.map((signal) => (
                <MetricCard
                  key={signal.key}
                  title={signal.label}
                  value={signal.value}
                  severity={signal.severity}
                  helper={signal.helper}
                  to={signal.drilldownTo}
                  explanation={{
                    formula: signal.formula,
                    asOf: data.asOfLabel,
                    queryHint: signal.queryHint,
                    sources: signal.sources,
                    scope: warehouseScope,
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </Section>

      {showReliabilitySection && (
        <Section>
          <SectionHeader
            title="Flow Reliability"
            description="Fill rate and backorder trend health."
            action={<Tooltip label="Backorder rate = 1 - fill rate. If no shipments exist, reliability is not measurable yet." />}
          />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {reliabilitySignals.map((signal) => (
              <MetricCard
                key={signal.key}
                title={signal.label}
                value={signal.value}
                severity={signal.severity}
                helper={signal.helper}
                to={signal.drilldownTo}
                explanation={{
                  formula: signal.formula,
                  asOf: data.asOfLabel,
                  queryHint: signal.queryHint,
                  sources: signal.sources,
                  scope: warehouseScope,
                }}
              />
            ))}
            {mode === 'all' && reliabilitySignals.length === 0 && (
              <Card>
                <EmptyState
                  title="Not measurable yet"
                  description="No shipment lines in the selected window, so fill and backorder rates are not measurable."
                  action={
                    <Link to="/shipments" className="text-sm font-semibold text-brand-700 hover:underline">
                      Review shipments
                    </Link>
                  }
                />
              </Card>
            )}
          </div>
        </Section>
      )}

      <Section>
        <SectionHeader
          title="Resolution Queue"
          description="Consolidated exception queue sorted by severity, business impact, and recency."
          action={
            <Link to="/dashboard/resolution-queue" className="text-sm font-semibold text-brand-700 hover:underline">
              View full queue
            </Link>
          }
        />
        <Card>
          {loading && <LoadingSpinner label="Loading resolution queue..." />}
          {!loading && error && <ErrorState error={error} />}
          {!loading && !error && queuePreview.length === 0 && (
            <EmptyState
              title="All clear"
              description="No pending approvals and no exception breaches detected."
            />
          )}
          {!loading && !error && queuePreview.length > 0 && (
            <DataTable
              rows={queuePreview}
              rowKey={(row) => row.id}
              columns={[
                {
                  id: 'severity',
                  header: 'Severity',
                  cell: (row) => <SeverityPill severity={row.severity} />,
                },
                {
                  id: 'type',
                  header: 'Exception',
                  cell: (row) => row.type.replaceAll('_', ' '),
                },
                {
                  id: 'item',
                  header: 'Item / SKU',
                  cell: (row) => (
                    <Link to={row.primaryLink} className="font-medium text-brand-700 hover:underline">
                      {row.itemLabel}
                    </Link>
                  ),
                },
                {
                  id: 'location',
                  header: 'Location / Warehouse',
                  cell: (row) => {
                    const location = row.locationId ? data.locationLookup.get(row.locationId) : null
                    const warehouseId = location?.warehouseId ?? null
                    const warehouse = warehouseId ? data.locationLookup.get(warehouseId) : null
                    return warehouse?.code ? `${row.locationLabel} (${warehouse.code})` : row.locationLabel
                  },
                },
                {
                  id: 'impact',
                  header: 'Impact',
                  align: 'right',
                  cell: (row) => formatNumber(Math.round(row.impactScore * 100) / 100),
                },
                {
                  id: 'action',
                  header: 'Recommended action',
                  cell: (row) => row.recommendedAction,
                },
              ]}
            />
          )}
        </Card>
      </Section>
    </div>
  )
}
