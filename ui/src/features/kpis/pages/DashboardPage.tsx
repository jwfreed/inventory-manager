import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getFulfillmentFillRate, listKpiRuns, listKpiSnapshots } from '../../../api/endpoints/kpis'
import { listReplenishmentRecommendations } from '../../../api/endpoints/planning'
import { listWorkOrders } from '../../../api/endpoints/workOrders'
import { listInventorySnapshotSummary } from '../../../api/endpoints/inventorySnapshot'
import { listItems } from '../../../api/endpoints/items'
import { listLocations } from '../../../api/endpoints/locations'
import { listPurchaseOrders } from '../../../api/endpoints/purchaseOrders'
import type { ApiError } from '../../../api/types'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { KpiCardGrid } from '../components/KpiCardGrid'
import { SnapshotsTable } from '../components/SnapshotsTable'
import { formatDateTime } from '../utils'
import { formatNumber } from '../../../lib/formatters'
import { Alert } from '../../../components/Alert'
import { InventorySnapshotTable } from '../../inventory/components/InventorySnapshotTable'

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

  const recommendationsQuery = useQuery({
    queryKey: ['replenishment-recommendations'],
    queryFn: () => listReplenishmentRecommendations({ limit: 10 }),
    staleTime: 30_000,
  })

  const inventorySummaryQuery = useQuery({
    queryKey: ['inventory-summary'],
    queryFn: () => listInventorySnapshotSummary({ limit: 500 }),
    staleTime: 30_000,
  })

  const itemsQuery = useQuery({
    queryKey: ['items', 'inventory-summary'],
    queryFn: () => listItems({ limit: 500 }),
    staleTime: 30_000,
  })

  const locationsQuery = useQuery({
    queryKey: ['locations', 'inventory-summary'],
    queryFn: () => listLocations({ limit: 500, active: true }),
    staleTime: 30_000,
  })

  const purchaseOrdersQuery = useQuery({
    queryKey: ['purchase-orders', 'dashboard'],
    queryFn: () => listPurchaseOrders({ limit: 200 }),
    staleTime: 30_000,
  })

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

  const inventoryPreviewRows = useMemo(
    () =>
      (inventorySummaryQuery.data ?? [])
        .slice()
        .sort((a, b) => a.available - b.available)
        .slice(0, 8),
    [inventorySummaryQuery.data],
  )

  const purchaseOrders = purchaseOrdersQuery.data?.data ?? []
  const draftPoCount = purchaseOrders.filter((po) => po.status === 'draft').length
  const submittedPurchaseOrders = purchaseOrders.filter((po) => po.status === 'submitted')
  const submittedPoCount = submittedPurchaseOrders.length

  const exceptionLoading = recommendationsQuery.isLoading || inventorySummaryQuery.isLoading
  const exceptionError = recommendationsQuery.isError || inventorySummaryQuery.isError
  const attentionLoading = exceptionLoading || purchaseOrdersQuery.isLoading
  const attentionError = exceptionError || purchaseOrdersQuery.isError
  const attentionCount =
    (purchaseOrdersQuery.isError ? 0 : draftPoCount + submittedPoCount) +
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
      helper: 'Awaiting receipt.',
      cta: (() => {
        if (!poReady) {
          return { label: 'Open receiving', to: '/receiving' }
        }
        if (submittedPoCount === 1) {
          return { label: 'Receive now', to: `/receiving?poId=${submittedPurchaseOrders[0].id}` }
        }
        if (submittedPoCount > 1) {
          return { label: 'Choose PO', to: '/purchase-orders?status=submitted&action=receive' }
        }
        return { label: 'View POs', to: '/purchase-orders?status=submitted' }
      })(),
    },
    {
      key: 'reorders',
      title: 'Reorders flagged',
      count: formatCount(reorderReady, reorderNeeded.length),
      signal: signalStyles[reorderSignal],
      helper: 'Policies triggered.',
      cta: { label: 'Review items', to: '/dashboard' },
    },
    {
      key: 'availability',
      title: 'Availability breaches',
      count: formatCount(availabilityReady, availabilityIssueCount),
      signal: signalStyles[availabilitySignal],
      helper: 'Zero or negative available.',
      cta: { label: 'Review items', to: '/dashboard' },
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

      <Section title="Attention required" description="Critical items that need action now.">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {attentionTiles.map((tile) => (
              <Card key={tile.key} className="h-full">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">{tile.title}</p>
                    <p className="mt-2 text-2xl font-semibold text-slate-900">{tile.count}</p>
                    <p className="mt-1 text-xs text-slate-500">{tile.helper}</p>
                  </div>
                  <Badge variant={tile.signal.variant}>{tile.signal.label}</Badge>
                </div>
                <div className="mt-3">
                  {tile.key === 'availability' || tile.key === 'reorders' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        const target = document.getElementById('attention-list')
                        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }}
                    >
                      {tile.cta.label}
                    </Button>
                  ) : (
                    <Link to={tile.cta.to}>
                      <Button size="sm" variant="secondary">
                        {tile.cta.label}
                      </Button>
                    </Link>
                  )}
                </div>
              </Card>
            ))}
          </div>

          <Card title="Resolution queue" description="Resolve exceptions and commitments before moving on.">
            {exceptionLoading && <LoadingSpinner label="Scanning for exceptions..." />}
            {exceptionError && (
              <Alert
                variant="error"
                title="Could not load exceptions"
                message="Retry to refresh recommendations and inventory coverage."
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      void recommendationsQuery.refetch()
                      void inventorySummaryQuery.refetch()
                    }}
                  >
                    Retry
                  </Button>
                }
              />
            )}
            {!exceptionLoading && !exceptionError && reorderNeeded.length === 0 && availabilityIssueCount === 0 && (
              <Alert
                variant="success"
                title="No immediate exceptions"
                message="No reorder flags and no zero/negative availability detected."
              />
            )}
            {!exceptionLoading &&
              !exceptionError &&
              (reorderNeeded.length > 0 || availabilityIssueCount > 0) && (
                <div id="attention-list" className="divide-y divide-slate-200">
                  {reorderNeeded.slice(0, 5).map((rec) => {
                    const threshold =
                      rec.policyType === 'q_rop'
                        ? rec.inputs.reorderPointQty ?? 0
                        : rec.inputs.orderUpToLevelQty ?? 0
                    const gap = rec.inventory.inventoryPosition - threshold
                    const poLink = `/purchase-orders/new?itemId=${encodeURIComponent(rec.itemId)}&locationId=${encodeURIComponent(
                      rec.locationId,
                    )}&qty=${encodeURIComponent(
                      String(rec.recommendation.recommendedOrderQty),
                    )}&uom=${encodeURIComponent(rec.uom)}`
                    return (
                      <div key={`reorder-${rec.policyId}`} className="py-3">
                        <div className="flex items-start justify-between gap-4">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <Badge variant="danger">Action required</Badge>
                              <span className="text-xs font-semibold uppercase text-slate-500">Reorder</span>
                            </div>
                            <p className="text-sm font-semibold text-slate-900">
                              Reorder: {formatItem(rec.itemId)} @ {formatLocation(rec.locationId)}
                            </p>
                            <p className="text-xs text-slate-600">
                              Inventory position {formatNumber(rec.inventory.inventoryPosition)} vs threshold{' '}
                              {formatNumber(threshold)} · gap {formatNumber(Math.abs(gap))}
                            </p>
                            <p className="text-xs text-slate-500">
                              Policy {rec.policyType} · Recommend order{' '}
                              {formatNumber(rec.recommendation.recommendedOrderQty)} {rec.uom}{' '}
                              {rec.recommendation.recommendedOrderDate
                                ? `by ${rec.recommendation.recommendedOrderDate}`
                                : ''}
                            </p>
                          </div>
                          <div className="flex flex-col items-end gap-2">
                            <Link to={poLink}>
                              <Button size="sm" variant="secondary">
                                Create PO
                              </Button>
                            </Link>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  {availabilityIssues.map((row) => {
                    const availabilitySeverity = row.available < 0 || row.inventoryPosition < 0
                    const availabilityLabel = availabilitySeverity ? 'Action required' : 'Watch'
                    const availabilityVariant = availabilitySeverity ? 'danger' : 'warning'
                    const itemLink = `/items/${row.itemId}?locationId=${encodeURIComponent(row.locationId)}`
                    return (
                      <div key={`avail-${row.itemId}-${row.locationId}-${row.uom}`} className="py-3">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <div className="flex items-center gap-2">
                              <Badge variant={availabilityVariant}>{availabilityLabel}</Badge>
                              <span className="text-xs font-semibold uppercase text-slate-500">Availability</span>
                            </div>
                            <p className="text-sm font-semibold text-slate-900">
                              Low/negative availability: {formatItem(row.itemId)} @ {formatLocation(row.locationId)}
                            </p>
                            <p className="text-xs text-slate-600">
                              Available {formatNumber(row.available)} {row.uom} · Inventory position{' '}
                              {formatNumber(row.inventoryPosition)}
                            </p>
                            <p className="text-xs text-slate-500">
                              On hand {formatNumber(row.onHand)} · Reserved {formatNumber(row.reserved)} · Incoming{' '}
                              {formatNumber(row.onOrder + row.inTransit)}
                            </p>
                          </div>
                          <div className="flex flex-col items-end gap-2">
                            <Link to={itemLink}>
                              <Button size="sm" variant="secondary">
                                Investigate
                              </Button>
                            </Link>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
          </Card>
        </div>
      </Section>

      <Section
        title="Flow health"
        description="Signals that show how inventory is moving and where it could stall next."
      >
        <div className="space-y-4">
          <Card
            title="Work in progress at risk"
            description="Largest remaining quantities across open work orders."
            action={
              <Link to="/work-orders">
                <Button size="sm" variant="secondary">
                  View work orders
                </Button>
              </Link>
            }
          >
            {productionQuery.isLoading && <LoadingSpinner label="Loading production summary..." />}
            {productionQuery.isError && productionQuery.error && (
              <ErrorState error={productionQuery.error as ApiError} onRetry={() => void productionQuery.refetch()} />
            )}
            {!productionQuery.isLoading && !productionQuery.isError && productionAtRisk.length === 0 && (
              <EmptyState
                title="No open work orders"
                description="When work orders have remaining quantities, they will appear here."
              />
            )}
            {!productionQuery.isLoading && !productionQuery.isError && productionAtRisk.length > 0 && (
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
                    {productionAtRisk.map((row) => (
                      <tr key={`${row.itemId}-${row.uom}`}>
                        <td className="px-3 py-2 text-sm text-slate-800">
                          <Link
                            to={`/work-orders?itemId=${encodeURIComponent(row.itemId)}`}
                            className="text-brand-700 hover:underline"
                          >
                            {formatItem(row.itemId)}
                          </Link>
                        </td>
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

          <Card
            title="Coverage snapshot"
            description="Lowest availability across items and locations."
            action={
              <Link to="/items">
                <Button size="sm" variant="secondary">
                  Browse items
                </Button>
              </Link>
            }
          >
            {inventoryLoading && <LoadingSpinner label="Loading inventory..." />}
            {inventoryError && (
              <ErrorState
                error={
                  (inventorySummaryQuery.error as ApiError) ||
                  (itemsQuery.error as ApiError) ||
                  (locationsQuery.error as ApiError)
                }
                onRetry={() => {
                  void inventorySummaryQuery.refetch()
                  void itemsQuery.refetch()
                  void locationsQuery.refetch()
                }}
              />
            )}
            {!inventoryLoading && !inventoryError && inventoryPreviewRows.length === 0 && (
              <EmptyState
                title="No inventory yet"
                description="Post receipts or completions to see on-hand by item/location."
              />
            )}
            {!inventoryLoading && !inventoryError && inventoryPreviewRows.length > 0 && (
              <InventorySnapshotTable
                rows={inventoryPreviewRows}
                itemLookup={itemLookup}
                locationLookup={locationLookup}
              />
            )}
          </Card>

          <Card
            title="Fulfillment reliability"
            description="Measured fill rate from shipped lines."
            action={
              <Link to="/shipments">
                <Button size="sm" variant="secondary">
                  Review shipments
                </Button>
              </Link>
            }
          >
            {fillRateCard}
          </Card>
        </div>
      </Section>

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
