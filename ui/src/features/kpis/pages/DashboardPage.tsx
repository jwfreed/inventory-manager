import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { runDashboardKpis } from '../api/kpis'
import { kpisQueryKeys, useKpiRuns } from '../queries'
import { useAuth } from '@shared/auth'
import { formatNumber } from '@shared/formatters'
import { inventoryQueryKeys } from '@features/inventory/queries'
import { itemsQueryKeys } from '@features/items/queries'
import { purchaseOrdersQueryKeys } from '@features/purchaseOrders/queries'
import { workOrdersQueryKeys } from '@features/workOrders/queries'
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
import { deriveAttentionState, filterResolutionQueue } from '../dashboardMath'
import {
  buildDashboardIdempotencyKey,
  buildDashboardModeStorageKey,
  medianRuntimeSeconds,
  parseRunMeta,
  readDashboardModeFromStorage,
  resolveWarehouseScopeLabel,
  selectLastSuccessfulRun,
  type DashboardMode,
} from '../dashboardPageUtils'
import { useDashboardSignals } from '../useDashboardSignals'
import { formatDateTime } from '../utils'

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

const KPI_WINDOW_DAYS = 90
const MONITORING_CTA_LINKS = {
  replenishment: '/replenishment-policies?source=dashboard',
  cycleCount: '/items',
  warehouseScope: '/items',
} as const

export default function DashboardPage() {
  const { user, tenant, hasPermission } = useAuth()
  const { data, loading, error } = useDashboardSignals()
  const queryClient = useQueryClient()
  const runsQuery = useKpiRuns({ limit: 25 }, { staleTime: 60_000 })
  const [runToastOpen, setRunToastOpen] = useState(false)
  const [copiedWarehouseId, setCopiedWarehouseId] = useState(false)

  const modeStorageKey = useMemo(
    () => buildDashboardModeStorageKey(tenant?.id, user?.id),
    [tenant?.id, user?.id],
  )
  const [mode, setMode] = useState<DashboardMode>(() =>
    readDashboardModeFromStorage(buildDashboardModeStorageKey(tenant?.id, user?.id)),
  )

  useEffect(() => {
    setMode(readDashboardModeFromStorage(modeStorageKey))
  }, [modeStorageKey])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(modeStorageKey, mode)
  }, [mode, modeStorageKey])

  useEffect(() => {
    if (!runToastOpen) return
    const timer = window.setTimeout(() => setRunToastOpen(false), 5000)
    return () => window.clearTimeout(timer)
  }, [runToastOpen])

  useEffect(() => {
    if (!copiedWarehouseId) return
    const timer = window.setTimeout(() => setCopiedWarehouseId(false), 1200)
    return () => window.clearTimeout(timer)
  }, [copiedWarehouseId])

  const allSignals = data.signals
  const visibleSignals = useMemo(
    () => (mode === 'actionable' ? allSignals.filter(isActionableSignal) : allSignals),
    [allSignals, mode],
  )
  const exceptionSignals = visibleSignals.filter((signal) => signal.type !== 'fulfillment_reliability')
  const allExceptionSignals = allSignals.filter((signal) => signal.type !== 'fulfillment_reliability')
  const exceptionCount = allExceptionSignals.reduce((total, signal) => total + signal.count, 0)
  const nonUomBlockingExceptionCount = allExceptionSignals
    .filter((signal) => signal.type !== 'uom_inconsistent' && rankSeverity(signal.severity) >= rankSeverity('action'))
    .reduce((total, signal) => total + signal.count, 0)
  const uomSignal = allExceptionSignals.find((signal) => signal.type === 'uom_inconsistent')
  const uomBlockingExceptionCount =
    data.uomDiagnosticGroupBuckets?.actionGroups ??
    (uomSignal && rankSeverity(uomSignal.severity) >= rankSeverity('action') ? uomSignal.count : 0)
  const blockingExceptionCount = nonUomBlockingExceptionCount + uomBlockingExceptionCount
  const urgentExceptions = allExceptionSignals.filter(
    (signal) => signal.count > 0 && rankSeverity(signal.severity) >= rankSeverity('action'),
  )
  const attentionState = deriveAttentionState({
    coverage: data.coverage,
    exceptionCount,
    blockingExceptionCount,
  })

  const allClear = attentionState === 'all_clear'
  const monitoringNotConfigured = attentionState === 'not_configured'
  const reliabilityNotMeasurable = !data.coverage.reliabilityMeasurable
  const showAllClearWithReplenishmentWarning =
    allClear && !data.coverage.replenishmentMonitoringConfigured && !monitoringNotConfigured

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
    return selectLastSuccessfulRun(list)
  }, [runsQuery.data])
  const latestRunMeta = parseRunMeta(latestRun?.notes)

  const historicalRuntimeSeconds = useMemo(() => {
    const list = runsQuery.data?.type === 'success' ? runsQuery.data.data : []
    const runtimes = list
      .map((run) => parseRunMeta(run.notes))
      .map((meta) => meta?.runtimeMs)
      .filter((runtime): runtime is number => typeof runtime === 'number' && runtime > 0)
    return medianRuntimeSeconds(runtimes)
  }, [runsQuery.data])

  const warehouseScopeId = useMemo(() => {
    const rawWarehouseId = latestRunMeta?.warehouseId ?? null
    if (!rawWarehouseId) return null
    return data.warehouseLookup.has(rawWarehouseId) ? rawWarehouseId : null
  }, [data.warehouseLookup, latestRunMeta?.warehouseId])

  const runMutation = useMutation({
    mutationFn: () =>
      runDashboardKpis({
        warehouseId: warehouseScopeId ?? undefined,
        windowDays: KPI_WINDOW_DAYS,
        idempotencyKey: buildDashboardIdempotencyKey({
          tenantId: tenant?.id,
          warehouseId: warehouseScopeId ?? undefined,
          windowDays: KPI_WINDOW_DAYS,
        }),
      }),
    onSuccess: () => {
      setRunToastOpen(true)
      void queryClient.invalidateQueries({ queryKey: kpisQueryKeys.runsPrefix() })
      void queryClient.invalidateQueries({ queryKey: kpisQueryKeys.snapshotsPrefix() })
      void queryClient.invalidateQueries({ queryKey: kpisQueryKeys.fulfillmentFillRatePrefix() })
      void queryClient.invalidateQueries({ queryKey: kpisQueryKeys.replenishmentRecommendationsPrefix() })
      void queryClient.invalidateQueries({ queryKey: kpisQueryKeys.replenishmentPoliciesPrefix() })
      void queryClient.invalidateQueries({ queryKey: kpisQueryKeys.dashboardOverviewPrefix() })
      void queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.all })
      void queryClient.invalidateQueries({ queryKey: purchaseOrdersQueryKeys.all })
      void queryClient.invalidateQueries({ queryKey: workOrdersQueryKeys.all })
      void queryClient.invalidateQueries({ queryKey: itemsQueryKeys.all })
      void runsQuery.refetch()
    },
  })

  const lastSuccessfulRunTimestamp =
    runMutation.data?.computedAt ?? latestRun?.finished_at ?? latestRun?.started_at ?? null
  const asOfTimestamp = runMutation.data?.asOf ?? latestRun?.as_of ?? data.asOfIso
  const displayWarehouseScope = useMemo(
    () =>
      resolveWarehouseScopeLabel({
        warehouseId: runMutation.data?.warehouseId ?? warehouseScopeId,
        warehouseLookup: data.warehouseLookup,
      }),
    [data.warehouseLookup, runMutation.data?.warehouseId, warehouseScopeId],
  )

  const hasReorderRisk = (allExceptionSignals.find((signal) => signal.type === 'reorder_risk')?.count ?? 0) > 0
  const canRunKpis = hasPermission('planning:write')

  const handleRunKpis = () => {
    if (!canRunKpis) return
    runMutation.mutate()
  }
  const additionalSections = [
    data.sections?.inventoryRisk,
    data.sections?.inventoryCoverage,
    data.sections?.supplyReliability,
    data.sections?.excessInventory,
    data.sections?.performanceMetrics,
    data.sections?.systemHealth,
    data.sections?.demandVolatility,
    data.sections?.forecastAccuracy,
  ].filter(Boolean)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle="Management-by-exception view of inventory risk, flow reliability, and corrective actions."
        meta={
          <div className="space-y-1 text-xs text-slate-500">
            <div>As of {data.asOfLabel}</div>
            <div className="flex flex-wrap items-center gap-2">
              <span>Warehouse scope: {displayWarehouseScope.label}</span>
              {displayWarehouseScope.rawId && (
                <>
                  <Tooltip label={`Raw warehouse ID: ${displayWarehouseScope.rawId}`} />
                  <button
                    type="button"
                    className="font-semibold text-brand-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                    onClick={() => {
                      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
                      const rawId = displayWarehouseScope.rawId
                      if (!rawId) return
                      void navigator.clipboard
                        .writeText(rawId)
                        .then(() => setCopiedWarehouseId(true))
                        .catch(() => undefined)
                    }}
                  >
                    {copiedWarehouseId ? 'Copied' : 'Copy ID'}
                  </button>
                </>
              )}
            </div>
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
        <div
          className={[
            'space-y-3 rounded-xl border p-4',
            urgentExceptions.length > 0
              ? 'border-rose-300 bg-rose-50/60'
              : monitoringNotConfigured
                ? 'border-amber-300 bg-amber-50/70'
                : 'border-slate-200 bg-white',
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
          {!loading && !error && monitoringNotConfigured && (
            <Banner
              severity="watch"
              title="Monitoring not configured"
              description="Coverage is incomplete. Configure policy controls before treating this dashboard as green."
              action={
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <Link to={MONITORING_CTA_LINKS.replenishment} className="font-semibold text-brand-700 hover:underline">
                    Configure replenishment policies
                  </Link>
                  <Link to={MONITORING_CTA_LINKS.cycleCount} className="font-semibold text-brand-700 hover:underline">
                    Set ABC / cycle count policy
                  </Link>
                  <Link to={MONITORING_CTA_LINKS.warehouseScope} className="font-semibold text-brand-700 hover:underline">
                    Select warehouse scope
                  </Link>
                </div>
              }
            />
          )}
          {!loading && !error && allClear && (
            <>
              {showAllClearWithReplenishmentWarning && (
                <Banner
                  severity="watch"
                  title="Replenishment monitoring not configured"
                  description="Exception monitoring is clear, but replenishment policy coverage is incomplete."
                  action={
                    <Link
                      to={MONITORING_CTA_LINKS.replenishment}
                      className="text-sm font-semibold text-brand-700 hover:underline"
                    >
                      Configure replenishment policies
                    </Link>
                  }
                />
              )}
              <Banner
                severity="info"
                title="All clear"
                description="No pending approvals or exception breaches detected."
                action={
                  <div className="flex items-center gap-3 text-sm">
                    {hasReorderRisk ? (
                      <Link to="/purchase-orders/new" className="font-semibold text-sky-800 hover:underline">
                        Create PO
                      </Link>
                    ) : data.coverage.hasCycleCountProgram ? (
                      <Link to="/items" className="font-semibold text-sky-800 hover:underline">
                        Review cycle counts
                      </Link>
                    ) : (
                      <Link to="/items" className="font-semibold text-sky-800 hover:underline">
                        Browse items
                      </Link>
                    )}
                  </div>
                }
              />
            </>
          )}
          {!loading && !error && attentionState === 'exceptions_present' && (
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
                    scope: displayWarehouseScope.label,
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
            description="Fill rate and unfilled-rate proxy health."
            action={
              <Tooltip label="Unfilled rate ≈ 1 - fill rate (proxy). True backorder rate requires backordered qty data." />
            }
          />
          {reliabilityNotMeasurable && (
            <Banner
              severity="info"
              title="Reliability not measurable yet"
              description="No shipped/requested quantity exists in this window, so unfilled rate remains a proxy only."
              action={
                <Link to="/shipments" className="text-sm font-semibold text-brand-700 hover:underline">
                  Review shipments
                </Link>
              }
            />
          )}
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
                  scope: displayWarehouseScope.label,
                }}
              />
            ))}
            {mode === 'all' && reliabilitySignals.length === 0 && (
              <Card>
                <EmptyState
                  title="Not measurable yet"
                  description="No shipment lines in the selected window, so fill and unfilled rates are not measurable."
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

      {additionalSections.map((section) => (
        <Section key={section.key}>
          <SectionHeader title={section.title} description={section.description} />
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {section.metrics.map((metric) => (
                <MetricCard
                  key={metric.key}
                  title={metric.label}
                  value={metric.value}
                  severity={metric.severity}
                  helper={metric.helper}
                  to={metric.drilldownTo}
                  explanation={{
                    formula: metric.formula,
                    asOf: data.asOfLabel,
                    queryHint: metric.queryHint,
                    sources: metric.sources,
                    scope: displayWarehouseScope.label,
                  }}
                />
              ))}
            </div>
            {section.rows.length > 0 && (
              <Card>
                <DataTable
                  rows={section.rows}
                  rowKey={(row) => row.id}
                  columns={[
                    {
                      id: 'severity',
                      header: 'Severity',
                      cell: (row) => <SeverityPill severity={row.severity} />,
                    },
                    {
                      id: 'label',
                      header: 'Entity',
                      cell: (row) => (
                        <Link to={row.drilldownTo} className="font-medium text-brand-700 hover:underline">
                          {row.label}
                        </Link>
                      ),
                    },
                    {
                      id: 'secondary',
                      header: 'Context',
                      cell: (row) => row.secondaryLabel ?? '—',
                    },
                    {
                      id: 'value',
                      header: 'Signal',
                      align: 'right',
                      cell: (row) => row.value,
                    },
                  ]}
                />
              </Card>
            )}
          </div>
        </Section>
      ))}

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
              title={monitoringNotConfigured ? 'Monitoring not configured' : 'All clear'}
              description={
                monitoringNotConfigured
                  ? 'Configure replenishment and cycle count policies before relying on this queue.'
                  : 'No pending approvals and no exception breaches detected.'
              }
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
                    const warehouse = row.warehouseId ? data.warehouseLookup.get(row.warehouseId) : null
                    return warehouse?.code ? `${row.locationLabel} — ${warehouse.code}` : row.locationLabel
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

      <Section>
        <SectionHeader
          title="System / Data Freshness"
          description="Read-only KPI refresh and data recency controls. This process does not mutate inventory transactions."
          action={
            <Button
              variant="secondary"
              onClick={handleRunKpis}
              disabled={!canRunKpis || runMutation.isPending}
              aria-label="Run KPI calculations"
            >
              {runMutation.isPending ? 'Running KPI calculations…' : 'Run KPI calculations'}
            </Button>
          }
        />
        {!canRunKpis && (
          <p className="text-xs text-slate-500">You need planning write permission to run KPI calculations.</p>
        )}
        <Card>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Last successful run</p>
              <p className="mt-1 text-sm text-slate-800">
                {lastSuccessfulRunTimestamp ? formatDateTime(lastSuccessfulRunTimestamp) : 'No run yet'}
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">As of</p>
              <p className="mt-1 text-sm text-slate-800">{formatDateTime(asOfTimestamp) || asOfTimestamp}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Runtime estimate</p>
              <p className="mt-1 text-sm text-slate-800">
                {historicalRuntimeSeconds
                  ? `Typical runtime under ${historicalRuntimeSeconds} seconds`
                  : 'Runtime varies by data volume.'}
              </p>
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
    </div>
  )
}
