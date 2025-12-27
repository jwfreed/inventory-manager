import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import type { ApiError } from '../../../api/types'
import { useInventorySnapshotSummary } from '../../inventory/queries'
import { useItemsList } from '../../items/queries'
import { useLocationsList } from '../../locations/queries'
import { usePurchaseOrdersList } from '../../purchaseOrders/queries'
import { useWorkOrdersList } from '../../workOrders/queries'
import { useFulfillmentFillRate, useKpiRuns, useKpiSnapshots, useReplenishmentRecommendations } from '../queries'
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
import { AttentionRequiredSection } from '../components/AttentionRequiredSection'
import { FlowHealthSection } from '../components/FlowHealthSection'

type SnapshotQueryResult = ReturnType<typeof useKpiSnapshots>['data']
type RunQueryResult = ReturnType<typeof useKpiRuns>['data']

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
  } = useKpiSnapshots({ limit: 200 }, { staleTime: 30_000 })

  const {
    data: runsResult,
    isLoading: runsLoading,
    isError: runsError,
    error: runsErrorObj,
    refetch: refetchRuns,
  } = useKpiRuns({ limit: 15 }, { staleTime: 60_000 })

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

  const productionQuery = useWorkOrdersList({ limit: 200 }, { staleTime: 30_000 })

  const fillRateQuery = useFulfillmentFillRate({}, { staleTime: 30_000 })

  const recommendationsQuery = useReplenishmentRecommendations({ limit: 10 }, { staleTime: 30_000 })

  const inventorySummaryQuery = useInventorySnapshotSummary({ limit: 500 }, { staleTime: 30_000 })

  const itemsQuery = useItemsList({ limit: 500 }, { staleTime: 30_000 })

  const locationsQuery = useLocationsList({ limit: 500, active: true }, { staleTime: 30_000 })

  const purchaseOrdersQuery = usePurchaseOrdersList({ limit: 200 }, { staleTime: 30_000 })

  const workOrders = productionQuery.data?.data ?? []
  const productionRows = workOrders.map((wo) => ({
    outputItemId: wo.outputItemId,
    uom: wo.outputUom,
    planned: wo.quantityPlanned,
    completed: wo.quantityCompleted ?? 0,
  }))

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

  const openWorkOrdersCount = workOrders.filter(
    (wo) => (wo.quantityCompleted ?? 0) < wo.quantityPlanned,
  ).length

  const productionAtRisk = useMemo(
    () =>
      productionList
        .filter((row) => row.remaining > 0)
        .sort((a, b) => b.remaining - a.remaining)
        .slice(0, 5),
    [productionList],
  )

  const itemLookup = useMemo(() => {
    const map = new Map<string, { sku?: string; name?: string }>()
    itemsQuery.data?.data?.forEach((item) => {
      map.set(item.id, { sku: item.sku, name: item.name })
    })
    return map
  }, [itemsQuery.data])

  const locationLookup = useMemo(() => {
    const map = new Map<string, { code?: string; name?: string }>()
    locationsQuery.data?.data?.forEach((loc) => {
      map.set(loc.id, { code: loc.code, name: loc.name })
    })
    return map
  }, [locationsQuery.data])

  const formatItem = (id: string) => {
    const item = itemLookup.get(id)
    if (!item) return id
    const sku = item.sku ?? id
    return item.name ? `${sku} — ${item.name}` : sku
  }

  const formatLocation = (id: string) => {
    const loc = locationLookup.get(id)
    if (!loc) return id
    const code = loc.code ?? id
    return loc.name ? `${code} — ${loc.name}` : code
  }

  const reorderNeeded = useMemo(
    () =>
      (recommendationsQuery.data?.data ?? []).filter(
        (r) => r.recommendation.reorderNeeded,
      ),
    [recommendationsQuery.data],
  )

  const availabilityIssueRows = useMemo(
    () =>
      (inventorySummaryQuery.data ?? [])
        .filter((row) => row.available <= 0 || row.inventoryPosition <= 0)
        .sort((a, b) => a.available - b.available),
    [inventorySummaryQuery.data],
  )

  const availabilityIssueCount = availabilityIssueRows.length
  const availabilityIssues = availabilityIssueRows.slice(0, 5)

  const purchaseOrders = purchaseOrdersQuery.data?.data ?? []
  const draftPoCount = purchaseOrders.filter((po) => po.status === 'draft').length
  const submittedPurchaseOrders = purchaseOrders.filter((po) => po.status === 'submitted')
  const submittedPoCount = submittedPurchaseOrders.length
  const approvedPurchaseOrders = purchaseOrders.filter(
    (po) => po.status === 'approved' || po.status === 'partially_received',
  )
  const approvedPoCount = approvedPurchaseOrders.length

  const exceptionLoading = recommendationsQuery.isLoading || inventorySummaryQuery.isLoading
  const exceptionError = recommendationsQuery.isError || inventorySummaryQuery.isError
  const attentionLoading = exceptionLoading || purchaseOrdersQuery.isLoading
  const attentionError = exceptionError || purchaseOrdersQuery.isError
  const attentionCount =
    (purchaseOrdersQuery.isError ? 0 : draftPoCount + submittedPoCount + approvedPoCount) +
    reorderNeeded.length +
    availabilityIssueCount

  type SignalState = 'normal' | 'watch' | 'action' | 'loading' | 'unavailable'

  const signalStyles: Record<
    SignalState,
    { label: string; variant: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; helper: string }
  > = {
    normal: { label: 'Normal', variant: 'success', helper: 'All clear' },
    watch: { label: 'Watch', variant: 'warning', helper: 'Review soon' },
    action: { label: 'Action required', variant: 'danger', helper: 'Needs action now' },
    loading: { label: 'Loading', variant: 'neutral', helper: 'Fetching data' },
    unavailable: { label: 'Unavailable', variant: 'danger', helper: 'Data unavailable' },
  }

  const draftPoSignal: SignalState = purchaseOrdersQuery.isError
    ? 'unavailable'
    : purchaseOrdersQuery.isLoading
      ? 'loading'
      : draftPoCount > 0
        ? 'watch'
        : 'normal'
  const submittedPoSignal: SignalState = purchaseOrdersQuery.isError
    ? 'unavailable'
    : purchaseOrdersQuery.isLoading
      ? 'loading'
      : submittedPoCount > 0
        ? 'action'
        : 'normal'
  const approvedPoSignal: SignalState = purchaseOrdersQuery.isError
    ? 'unavailable'
    : purchaseOrdersQuery.isLoading
      ? 'loading'
      : approvedPoCount > 0
        ? 'action'
        : 'normal'
  const reorderSignal: SignalState = recommendationsQuery.isError
    ? 'unavailable'
    : recommendationsQuery.isLoading
      ? 'loading'
      : reorderNeeded.length > 0
        ? 'action'
        : 'normal'
  const availabilitySignal: SignalState = inventorySummaryQuery.isError
    ? 'unavailable'
    : inventorySummaryQuery.isLoading
      ? 'loading'
      : availabilityIssueCount > 0
        ? 'action'
        : 'normal'
  const workOrdersSignal: SignalState = productionQuery.isError
    ? 'unavailable'
    : productionQuery.isLoading
      ? 'loading'
      : openWorkOrdersCount > 0
        ? 'watch'
        : 'normal'

  const formatCount = (ready: boolean, value: number) => (ready ? formatNumber(value) : '—')

  const attentionSummary =
    attentionLoading || attentionError
      ? null
      : attentionCount === 0
        ? { label: 'All caught up', variant: 'success' as const }
        : { label: `${attentionCount} items need attention`, variant: 'warning' as const }

  const poReady = !purchaseOrdersQuery.isLoading && !purchaseOrdersQuery.isError
  const reorderReady = !recommendationsQuery.isLoading && !recommendationsQuery.isError
  const availabilityReady = !inventorySummaryQuery.isLoading && !inventorySummaryQuery.isError
  const workOrdersReady = !productionQuery.isLoading && !productionQuery.isError

  const attentionTiles = [
    {
      key: 'draft-pos',
      title: 'Draft POs',
      count: formatCount(poReady, draftPoCount),
      signal: signalStyles[draftPoSignal],
      helper: 'Awaiting submission.',
      cta: { label: 'Review drafts', to: '/purchase-orders?status=draft' },
    },
    {
      key: 'submitted-pos',
      title: 'Submitted POs',
      count: formatCount(poReady, submittedPoCount),
      signal: signalStyles[submittedPoSignal],
      helper: 'Awaiting approval.',
      cta: (() => {
        if (!poReady) {
          return { label: 'View POs', to: '/purchase-orders?status=submitted' }
        }
        if (submittedPoCount === 1) {
          return { label: 'Review PO', to: `/purchase-orders/${submittedPurchaseOrders[0].id}` }
        }
        if (submittedPoCount > 1) {
          return { label: 'View submitted', to: '/purchase-orders?status=submitted' }
        }
        return { label: 'View POs', to: '/purchase-orders?status=submitted' }
      })(),
    },
    {
      key: 'approved-pos',
      title: 'Approved POs',
      count: formatCount(poReady, approvedPoCount),
      signal: signalStyles[approvedPoSignal],
      helper: 'Awaiting receipt.',
      cta: (() => {
        if (!poReady) {
          return { label: 'Open receiving', to: '/receiving' }
        }
        if (approvedPoCount === 1) {
          return { label: 'Receive now', to: `/receiving?poId=${approvedPurchaseOrders[0].id}` }
        }
        if (approvedPoCount > 1) {
          return { label: 'Choose PO', to: '/purchase-orders?status=approved&action=receive' }
        }
        return { label: 'View POs', to: '/purchase-orders?status=approved' }
      })(),
    },
    {
      key: 'reorders',
      title: 'Reorders flagged',
      count: formatCount(reorderReady, reorderNeeded.length),
      signal: signalStyles[reorderSignal],
      helper: 'Policies triggered.',
      cta: { label: 'Review items', to: '/items' },
      scrollTarget: true,
    },
    {
      key: 'availability',
      title: 'Availability breaches',
      count: formatCount(availabilityReady, availabilityIssueCount),
      signal: signalStyles[availabilitySignal],
      helper: 'Zero or negative available.',
      cta: { label: 'Review items', to: '/items' },
      scrollTarget: true,
    },
    {
      key: 'work-orders',
      title: 'Open work orders',
      count: formatCount(workOrdersReady, openWorkOrdersCount),
      signal: signalStyles[workOrdersSignal],
      helper: 'Remaining production.',
      cta: { label: 'View work orders', to: '/work-orders' },
    },
  ]

  const inventoryLoading = inventorySummaryQuery.isLoading || itemsQuery.isLoading || locationsQuery.isLoading
  const inventoryError = inventorySummaryQuery.isError || itemsQuery.isError || locationsQuery.isError

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
          Start here to resolve exceptions and commitments. Every card points to a next step.
        </p>
        {attentionSummary && (
          <div className="flex items-center gap-2">
            <Badge variant={attentionSummary.variant}>{attentionSummary.label}</Badge>
            <span className="text-xs text-slate-500">Work pulled forward so you can act fast.</span>
          </div>
        )}
      </div>

      <AttentionRequiredSection
        tiles={attentionTiles}
        exceptionLoading={exceptionLoading}
        exceptionError={exceptionError}
        reorderNeeded={reorderNeeded}
        availabilityIssues={availabilityIssues}
        formatItem={formatItem}
        formatLocation={formatLocation}
        onRetry={() => {
          void recommendationsQuery.refetch()
          void inventorySummaryQuery.refetch()
        }}
      />

      <FlowHealthSection
        productionRows={productionAtRisk}
        productionLoading={productionQuery.isLoading}
        productionError={productionQuery.isError}
        productionErrorObj={productionQuery.error as ApiError}
        onProductionRetry={() => void productionQuery.refetch()}
        availabilityIssues={availabilityIssues}
        inventoryLoading={inventoryLoading}
        inventoryError={inventoryError}
        inventoryErrorObj={
          (inventorySummaryQuery.error as ApiError) ||
          (itemsQuery.error as ApiError) ||
          (locationsQuery.error as ApiError)
        }
        onInventoryRetry={() => {
          void inventorySummaryQuery.refetch()
          void itemsQuery.refetch()
          void locationsQuery.refetch()
        }}
        formatItem={formatItem}
        formatLocation={formatLocation}
        fillRateCard={fillRateCard}
      />

      <Section title="Context" description="Secondary metrics and historical signals for deeper investigation.">
        <div className="space-y-4">
          <Card title="KPI cards">
            {snapshotsLoading || snapshotsFetching ? (
              <LoadingSpinner label="Loading KPI snapshots..." />
            ) : null}
            {snapshotsError && snapshotsErrorObj ? (
              <ErrorState error={snapshotsErrorObj} onRetry={() => void refetchSnapshots()} />
            ) : null}
            {!snapshotsLoading && !snapshotsFetching && !snapshotsError && snapshotApiMissing ? (
              <EmptyState title="KPI API not available yet" description={snapshotUnavailableDescription} />
            ) : null}
            {!snapshotsLoading && !snapshotsFetching && snapshotsAvailable && snapshotList.length === 0 ? (
              <EmptyState
                title="No KPI snapshots yet."
                description="Once KPI runs publish snapshots, the latest values will appear here."
              />
            ) : null}
            {!snapshotsLoading && snapshotsAvailable && snapshotList.length > 0 ? (
              <KpiCardGrid snapshots={snapshotList} />
            ) : null}
          </Card>

          <Card title="KPI snapshots">
            {snapshotsLoading || snapshotsFetching ? (
              <LoadingSpinner label="Loading KPI snapshots..." />
            ) : null}
            {snapshotsError && snapshotsErrorObj ? (
              <ErrorState error={snapshotsErrorObj} onRetry={() => void refetchSnapshots()} />
            ) : null}
            {!snapshotsLoading && !snapshotsFetching && snapshotApiMissing ? (
              <EmptyState title="KPI API not available yet" description={snapshotUnavailableDescription} />
            ) : null}
            {!snapshotsLoading && snapshotsAvailable && snapshotList.length === 0 && !snapshotsError ? (
              <EmptyState
                title="No KPI snapshots yet."
                description="Run a KPI computation job to populate snapshots."
              />
            ) : null}
            {snapshotsAvailable && snapshotList.length > 0 ? <SnapshotsTable snapshots={snapshotList} /> : null}
          </Card>

          <Card title="KPI runs" description="Latest run metadata reported by the API.">
            {runsLoading && <LoadingSpinner label="Loading KPI runs..." />}
            {runsError && runsErrorObj && <ErrorState error={runsErrorObj} onRetry={() => void refetchRuns()} />}
            {runsResult && runsResult.type === 'ApiNotAvailable' && (
              <EmptyState title="KPI run API not available" description={runUnavailableDescription} />
            )}
            {runsResult && runsResult.type === 'success' && runsResult.data.length === 0 && (
              <EmptyState
                title="No KPI runs yet"
                description="Run a KPI computation job to populate runs."
              />
            )}
            {runsResult && runsResult.type === 'success' && runsResult.data.length > 0 && (
              <div className="divide-y divide-slate-200">
                {runsResult.data.slice(0, 5).map((run) => (
                  <div key={run.id || `${run.status}-${run.started_at}`} className="py-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Badge variant="neutral">{run.status}</Badge>
                        {run.as_of ? (
                          <span className="text-xs text-slate-500">As of {formatDateTime(run.as_of)}</span>
                        ) : null}
                      </div>
                      <div className="text-xs text-slate-500">
                        {run.started_at && <span className="mr-2">Started {formatDateTime(run.started_at)}</span>}
                        {run.finished_at && (
                          <span className="text-slate-500">Finished {formatDateTime(run.finished_at)}</span>
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
            )}
          </Card>
        </div>
      </Section>
    </div>
  )
}
