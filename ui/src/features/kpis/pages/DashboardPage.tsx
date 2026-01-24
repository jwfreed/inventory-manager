import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ApiError } from '@api/types'
import { useInventorySnapshotSummary } from '@features/inventory/queries'
import { useItemsList } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'
import { usePurchaseOrdersList } from '@features/purchaseOrders/queries'
import { useWorkOrdersList } from '@features/workOrders/queries'
import { useFulfillmentFillRate, useKpiRuns, useKpiSnapshots, useReplenishmentRecommendations } from '../queries'
import { Alert, Badge, Button, Card, EmptyState, ErrorState, LoadingSpinner, Modal, Section } from '@shared/ui'
import { KpiCardGrid } from '../components/KpiCardGrid'
import { SnapshotsTable } from '../components/SnapshotsTable'
import { formatDateTime } from '../utils'
import { formatNumber } from '@shared/formatters'
import { FlowHealthSection } from '../components/FlowHealthSection'
import { useAuth } from '@shared/auth'
import { trackDashboardEvent } from '../analytics'
import { buildKpiCatalog, buildLatestSnapshotMap, resolveDefaultKpi, resolveKpiDefinition, resolveMissingDimensions } from '../tradeoff'
import { clearTradeoffPreferences, loadTradeoffPreferences, saveTradeoffPreferences, TRADEOFF_DIMENSIONS, type TradeoffSlot } from '../tradeoffPreferences'

type SnapshotQueryResult = ReturnType<typeof useKpiSnapshots>['data']
type RunQueryResult = ReturnType<typeof useKpiRuns>['data']

function attemptedEndpoints(result?: SnapshotQueryResult | RunQueryResult) {
  if (!result) return []
  if ('attemptedEndpoints' in result) return result.attemptedEndpoints
  if ('attempted' in result) return result.attempted
  return []
}

export default function DashboardPage() {
  const { role } = useAuth()
  const [tradeoffOpen, setTradeoffOpen] = useState(false)
  const [tradeoffPrefs, setTradeoffPrefs] = useState(loadTradeoffPreferences)
  const [tradeoffDraft, setTradeoffDraft] = useState<Partial<Record<TradeoffSlot, string>>>({})
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

  useEffect(() => {
    trackDashboardEvent('dashboard_viewed')
  }, [])

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

  const latestSnapshots = useMemo(() => buildLatestSnapshotMap(snapshotList), [snapshotList])
  const availableKpis = useMemo(() => new Set(latestSnapshots.keys()), [latestSnapshots])
  const kpiCatalog = useMemo(() => buildKpiCatalog(snapshotList), [snapshotList])
  const defaultSelections = useMemo(() => {
    const selections: Partial<Record<TradeoffSlot, string>> = {}
    TRADEOFF_DIMENSIONS.forEach((dimension) => {
      selections[dimension] = resolveDefaultKpi(dimension, availableKpis) ?? undefined
    })
    return selections
  }, [availableKpis])
  const resolvedSelections = useMemo(() => ({
    ...defaultSelections,
    ...tradeoffPrefs.selections,
  }), [defaultSelections, tradeoffPrefs.selections])

  const catalogOptions = useMemo(
    () =>
      [...kpiCatalog].sort((a, b) => {
        if (a.dimension === b.dimension) return a.displayName.localeCompare(b.displayName)
        return a.dimension.localeCompare(b.dimension)
      }),
    [kpiCatalog],
  )

  const selectedDefinitions = TRADEOFF_DIMENSIONS.map((dimension) => {
    const selectedName = resolvedSelections[dimension] ?? null
    return resolveKpiDefinition(selectedName) ??
      kpiCatalog.find((kpi) => kpi.name === selectedName) ??
      null
  }).filter(Boolean)

  const missingDimensions = resolveMissingDimensions(selectedDefinitions as NonNullable<ReturnType<typeof resolveKpiDefinition>>[])
  const showTradeoffWarning = missingDimensions.length > 0 && snapshotList.length > 0

  useEffect(() => {
    saveTradeoffPreferences(tradeoffPrefs)
  }, [tradeoffPrefs])

  useEffect(() => {
    if (!tradeoffOpen) return
    setTradeoffDraft(resolvedSelections)
  }, [tradeoffOpen, resolvedSelections])

  useEffect(() => {
    trackDashboardEvent('dashboard_tradeoff_snapshot_viewed')
  }, [])

  useEffect(() => {
    if (!showTradeoffWarning) return
    trackDashboardEvent('dashboard_tradeoff_warning_shown', {
      missing_dimensions: missingDimensions,
    })
  }, [showTradeoffWarning, missingDimensions])

  const handleTradeoffSave = () => {
    setTradeoffPrefs({ version: 1, selections: tradeoffDraft })
    setTradeoffOpen(false)
  }

  const handleTradeoffReset = () => {
    clearTradeoffPreferences()
    setTradeoffPrefs({ version: 1, selections: {} })
    setTradeoffDraft(defaultSelections)
    trackDashboardEvent('dashboard_tradeoff_reset_default')
  }

  const handleRecommendedAdd = (dimension: TradeoffSlot) => {
    const recommended = defaultSelections[dimension]
    if (!recommended) return
    setTradeoffPrefs((prev) => ({
      ...prev,
      selections: { ...prev.selections, [dimension]: recommended },
    }))
    trackDashboardEvent('dashboard_tradeoff_recommendation_clicked', {
      dimension,
      kpi: recommended,
    })
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

  const flowHealthStatus =
    availabilityIssueCount > 0 || submittedPoCount > 0 || approvedPoCount > 0 ? 'at-risk' : 'stable'
  const flowHealthBadge =
    flowHealthStatus === 'at-risk'
      ? { label: 'At risk', variant: 'danger' as const, icon: '!' }
      : { label: 'Stable', variant: 'success' as const, icon: 'OK' }

  const isPrivileged = useMemo(() => {
    const normalized = (role ?? '').toLowerCase()
    return normalized.includes('admin') || normalized.includes('manager')
  }, [role])
  const [analyticsExpanded, setAnalyticsExpanded] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    const stored = window.localStorage.getItem('dashboard-analytics-expanded')
    if (stored !== null) return stored === 'true'
    return false
  })
  const [showAllSignals, setShowAllSignals] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = window.localStorage.getItem('dashboard-analytics-expanded')
    if (stored !== null) return
    setAnalyticsExpanded(isPrivileged)
  }, [isPrivileged])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('dashboard-analytics-expanded', String(analyticsExpanded))
  }, [analyticsExpanded])

  const previewItems = (values: string[]) => {
    const top = values.filter(Boolean).slice(0, 2)
    if (top.length === 0) return null
    return `Top: ${top.join(' · ')}`
  }

  const draftPreview = previewItems(
    purchaseOrders.filter((po) => po.status === 'draft').map((po) => po.poNumber ?? po.id.slice(0, 8)),
  )
  const submittedPreview = previewItems(
    submittedPurchaseOrders.map((po) => po.poNumber ?? po.id.slice(0, 8)),
  )
  const approvedPreview = previewItems(
    approvedPurchaseOrders.map((po) => po.poNumber ?? po.id.slice(0, 8)),
  )
  const reorderPreview = previewItems(
    reorderNeeded.map(
      (rec) =>
        `${formatItem(rec.itemId)} (${formatNumber(rec.recommendation.recommendedOrderQty)} ${rec.uom})`,
    ),
  )
  const availabilityPreview = previewItems(
    availabilityIssues.map(
      (row) =>
        `${formatItem(row.itemId)} @ ${formatLocation(row.locationId)} (${formatNumber(row.available)})`,
    ),
  )
  const workOrderPreview = previewItems(
    productionAtRisk.map(
      (row) => `${formatItem(row.itemId)} (${formatNumber(row.remaining)} ${row.uom})`,
    ),
  )

  type AttentionTier = 'act' | 'review' | 'info'
  type AttentionTile = {
    key: string
    title: string
    count: string
    helper: string
    signal: { label: string; variant: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }
    cta: { label: string; to: string }
    preview?: string | null
    tier: AttentionTier
  }

  const poReady = !purchaseOrdersQuery.isLoading && !purchaseOrdersQuery.isError
  const reorderReady = !recommendationsQuery.isLoading && !recommendationsQuery.isError
  const availabilityReady = !inventorySummaryQuery.isLoading && !inventorySummaryQuery.isError
  const workOrdersReady = !productionQuery.isLoading && !productionQuery.isError

  const attentionTiles: AttentionTile[] = [
    {
      key: 'draft-pos',
      title: 'Draft POs',
      count: formatCount(poReady, draftPoCount),
      signal: signalStyles[draftPoSignal],
      helper: 'Awaiting submission.',
      cta: { label: 'Review drafts', to: '/purchase-orders?status=draft' },
      preview: draftPoCount > 0 ? draftPreview : null,
      tier: 'review',
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
      preview: submittedPoCount > 0 ? submittedPreview : null,
      tier: 'act',
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
      preview: approvedPoCount > 0 ? approvedPreview : null,
      tier: 'act',
    },
    {
      key: 'reorders',
      title: 'Reorders flagged',
      count: formatCount(reorderReady, reorderNeeded.length),
      signal: signalStyles[reorderSignal],
      helper: 'Policies triggered.',
      cta: { label: 'Review reorders', to: '/items' },
      preview: reorderNeeded.length > 0 ? reorderPreview : null,
      tier: 'info',
    },
    {
      key: 'availability',
      title: 'Availability breaches',
      count: formatCount(availabilityReady, availabilityIssueCount),
      signal: signalStyles[availabilitySignal],
      helper: 'Zero or negative available.',
      cta: { label: 'Investigate availability', to: '/items' },
      preview: availabilityIssueCount > 0 ? availabilityPreview : null,
      tier: 'act',
    },
    {
      key: 'work-orders',
      title: 'Open work orders',
      count: formatCount(workOrdersReady, openWorkOrdersCount),
      signal: signalStyles[workOrdersSignal],
      helper: 'Remaining production.',
      cta: { label: 'Review work orders', to: '/work-orders' },
      preview: openWorkOrdersCount > 0 ? workOrderPreview : null,
      tier: 'review',
    },
  ]

  const tier1Tiles = attentionTiles.filter((tile) => tile.tier === 'act')
  const tier2Tiles = attentionTiles.filter((tile) => tile.tier === 'review')
  const tier3Tiles = attentionTiles.filter((tile) => tile.tier === 'info')

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
          Operational health &amp; exceptions.
        </p>
        {attentionSummary && (
          <div className="flex items-center gap-2">
            <Badge variant={attentionSummary.variant}>{attentionSummary.label}</Badge>
            <span className="text-xs text-slate-500">Work pulled forward so you can act fast.</span>
          </div>
        )}
      </div>

      <Section title="Attention required" description="Operational exceptions that need action now.">
        <div className="space-y-4">
          <div className="rounded-xl border border-red-200 bg-red-50/30 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-900">Act now</div>
              <Badge variant="danger">Critical</Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {tier1Tiles.map((tile) => (
                <div
                  key={tile.key}
                  tabIndex={0}
                  className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400"
                >
                  <Card className="h-full border-red-200">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-xs uppercase tracking-wide text-slate-500">{tile.title}</p>
                        <p className="mt-2 text-2xl font-semibold text-slate-900">{tile.count}</p>
                        <p className="mt-1 text-xs text-slate-500">{tile.helper}</p>
                        {tile.preview && (
                          <p className="mt-2 text-xs text-slate-600">{tile.preview}</p>
                        )}
                      </div>
                      <Badge variant={tile.signal.variant}>{tile.signal.label}</Badge>
                    </div>
                    <div className="mt-3">
                      <Link to={tile.cta.to}>
                        <Button size="sm">{tile.cta.label}</Button>
                      </Link>
                    </div>
                  </Card>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-900">Review soon</div>
              <Badge variant="warning">Watch</Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {tier2Tiles.map((tile) => (
                <div
                  key={tile.key}
                  tabIndex={0}
                  className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-300"
                >
                  <Card className="h-full">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-xs uppercase tracking-wide text-slate-500">{tile.title}</p>
                        <p className="mt-2 text-2xl font-semibold text-slate-900">{tile.count}</p>
                        <p className="mt-1 text-xs text-slate-500">{tile.helper}</p>
                        {tile.preview && (
                          <p className="mt-2 text-xs text-slate-600">{tile.preview}</p>
                        )}
                      </div>
                      <Badge variant={tile.signal.variant}>{tile.signal.label}</Badge>
                    </div>
                    <div className="mt-3">
                      <Link to={tile.cta.to}>
                        <Button size="sm" variant="secondary">
                          {tile.cta.label}
                        </Button>
                      </Link>
                    </div>
                  </Card>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-900">Informational</div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setShowAllSignals((prev) => !prev)}
              >
                {showAllSignals ? 'Hide signals' : 'View all signals'}
              </Button>
            </div>
            {showAllSignals && (
              <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {tier3Tiles.map((tile) => (
                  <div
                    key={tile.key}
                    tabIndex={0}
                    className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-300"
                  >
                    <Card className="h-full">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xs uppercase tracking-wide text-slate-500">{tile.title}</p>
                          <p className="mt-2 text-2xl font-semibold text-slate-900">{tile.count}</p>
                          <p className="mt-1 text-xs text-slate-500">{tile.helper}</p>
                          {tile.preview && (
                            <p className="mt-2 text-xs text-slate-600">{tile.preview}</p>
                          )}
                        </div>
                        <Badge variant={tile.signal.variant}>{tile.signal.label}</Badge>
                      </div>
                      <div className="mt-3">
                        <Link to={tile.cta.to}>
                          <Button size="sm" variant="secondary">
                            {tile.cta.label}
                          </Button>
                        </Link>
                      </div>
                    </Card>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Card title="Resolution queue" description="Resolve exceptions and commitments before moving on.">
            {exceptionLoading && <LoadingSpinner label="Scanning for exceptions..." />}
            {exceptionError && (
              <Alert
                variant="error"
                title="Could not load exceptions"
                message="Retry to refresh recommendations and inventory coverage."
                action={
                  <Button size="sm" variant="secondary" onClick={() => {
                    void recommendationsQuery.refetch()
                    void inventorySummaryQuery.refetch()
                  }}>
                    Retry
                  </Button>
                }
              />
            )}
            {!exceptionLoading && !exceptionError && reorderNeeded.length === 0 && availabilityIssues.length === 0 && (
              <Alert
                variant="success"
                title="No immediate exceptions"
                message="No reorder flags and no zero/negative availability detected."
              />
            )}
            {!exceptionLoading &&
              !exceptionError &&
              (reorderNeeded.length > 0 || availabilityIssues.length > 0) && (
                <div className="divide-y divide-slate-200">
                  <div className="py-2 text-xs text-slate-500">
                    Exceptions only. Open Item → Stock for authoritative totals.
                  </div>
                  {reorderNeeded.slice(0, 5).map((rec) => {
                    const threshold =
                      rec.policyType === 'q_rop'
                        ? rec.inputs.reorderPointQty ?? 0
                        : rec.inputs.orderUpToLevelQty ?? 0
                    const gap = rec.inventory.inventoryPosition - threshold
                    const poLink = `/purchase-orders/new?itemId=${encodeURIComponent(rec.itemId)}&locationId=${encodeURIComponent(
                      rec.locationId,
                    )}&qty=${encodeURIComponent(String(rec.recommendation.recommendedOrderQty))}&uom=${encodeURIComponent(rec.uom)}`
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
                  {availabilityIssues.slice(0, 5).map((row) => {
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
                            <p className="text-xs text-slate-500">
                              Open Item → Stock for definitive on-hand, availability, and incoming.
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
        title="Tradeoff snapshot"
        description="Service, cost, and risk tradeoffs at a glance."
        action={
          <Button size="sm" variant="secondary" onClick={() => {
            setTradeoffOpen(true)
            trackDashboardEvent('dashboard_tradeoff_customize_opened')
          }}>
            Customize KPIs
          </Button>
        }
      >
        {showTradeoffWarning && (
          <Alert
            variant="warning"
            title="Heads up"
            message={`Excluding ${missingDimensions.join(', ')} can hide important tradeoffs.`}
            action={
              <div className="flex flex-wrap gap-2">
                {missingDimensions.map((dimension) => (
                  <Button
                    key={dimension}
                    size="sm"
                    variant="secondary"
                    onClick={() => handleRecommendedAdd(dimension)}
                    disabled={!defaultSelections[dimension]}
                  >
                    Add recommended {dimension}
                  </Button>
                ))}
              </div>
            }
          />
        )}
        {!snapshotsAvailable || snapshotList.length === 0 ? (
          <div className="space-y-3">
            <EmptyState
              title="No KPI snapshots yet."
              description="Run a KPI computation job to populate these cards."
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setAnalyticsExpanded(true)
                    setTimeout(() => {
                      document.getElementById('kpi-runs')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }, 0)
                  }}
                >
                  Go to KPI runs
                </Button>
              }
            />
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
              Selections saved:
              <div className="mt-2 grid gap-1 sm:grid-cols-2">
                {TRADEOFF_DIMENSIONS.map((dimension) => {
                  const selectedName = resolvedSelections[dimension] ?? null
                  const definition =
                    resolveKpiDefinition(selectedName) ??
                    kpiCatalog.find((kpi) => kpi.name === selectedName) ??
                    null
                  return (
                    <div key={`selection-${dimension}`}>
                      <span className="font-semibold">{dimension}:</span>{' '}
                      {definition?.displayName ?? selectedName ?? 'Not set'}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {TRADEOFF_DIMENSIONS.map((dimension) => {
              const selectedName = resolvedSelections[dimension] ?? null
              const snapshot = selectedName ? latestSnapshots.get(selectedName) : null
              const definition =
                resolveKpiDefinition(selectedName) ??
                kpiCatalog.find((kpi) => kpi.name === selectedName) ??
                null
              const displayName = definition?.displayName ?? selectedName ?? 'Not available'
              const description = definition?.description ?? 'Metric unsupported.'
              const value =
                snapshot?.value != null
                  ? typeof snapshot.value === 'number'
                    ? formatNumber(snapshot.value)
                    : snapshot.value
                  : 'Not available'
              const unit = snapshot?.unit ?? null

              return (
                <div
                  key={`tradeoff-${dimension}`}
                  className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {dimension}
                    </span>
                    <Badge variant="neutral">{definition?.dimension ?? 'OTHER'}</Badge>
                  </div>
                  <p className="mt-2 text-sm font-semibold text-slate-900">{displayName}</p>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-2xl font-semibold text-slate-900">{value}</span>
                    {unit ? <span className="text-xs font-medium text-slate-500">{unit}</span> : null}
                  </div>
                  {snapshot?.computed_at ? (
                    <p className="mt-2 text-xs text-slate-500">
                      As of {formatDateTime(snapshot.computed_at) || 'unknown'}
                    </p>
                  ) : (
                    <p className="mt-2 text-xs text-slate-500">{description}</p>
                  )}
                  {!snapshot && (
                    <div className="mt-3">
                      <Button size="sm" variant="secondary" onClick={() => setTradeoffOpen(true)}>
                        Choose another KPI
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Section>

      <Section>
        <Card title="Resolution queue" description="Resolve exceptions and commitments before moving on.">
          {exceptionLoading && <LoadingSpinner label="Scanning for exceptions..." />}
          {exceptionError && (
            <Alert
              variant="error"
              title="Could not load exceptions"
              message="Retry to refresh recommendations and inventory coverage."
              action={
                <Button size="sm" variant="secondary" onClick={() => {
                  void recommendationsQuery.refetch()
                  void inventorySummaryQuery.refetch()
                }}>
                  Retry
                </Button>
              }
            />
          )}
          {!exceptionLoading && !exceptionError && reorderNeeded.length === 0 && availabilityIssues.length === 0 && (
            <Alert
              variant="success"
              title="No immediate exceptions"
              message="No reorder flags and no zero/negative availability detected."
            />
          )}
          {!exceptionLoading &&
            !exceptionError &&
            (reorderNeeded.length > 0 || availabilityIssues.length > 0) && (
              <div className="divide-y divide-slate-200">
                <div className="py-2 text-xs text-slate-500">
                  Exceptions only. Open Item → Stock for authoritative totals.
                </div>
                {reorderNeeded.slice(0, 5).map((rec) => {
                  const threshold =
                    rec.policyType === 'q_rop'
                      ? rec.inputs.reorderPointQty ?? 0
                      : rec.inputs.orderUpToLevelQty ?? 0
                  const gap = rec.inventory.inventoryPosition - threshold
                  const poLink = `/purchase-orders/new?itemId=${encodeURIComponent(rec.itemId)}&locationId=${encodeURIComponent(
                    rec.locationId,
                  )}&qty=${encodeURIComponent(String(rec.recommendation.recommendedOrderQty))}&uom=${encodeURIComponent(rec.uom)}`
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
                {availabilityIssues.slice(0, 5).map((row) => {
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
                          <p className="text-xs text-slate-500">
                            Open Item → Stock for definitive on-hand, availability, and incoming.
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
      </Section>

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
        summary={flowHealthBadge}
      />

      <Section
        title="Analytical context"
        description="Advanced metrics for deeper investigation."
        action={
          <Button size="sm" variant="secondary" onClick={() => setAnalyticsExpanded((prev) => !prev)}>
            {analyticsExpanded ? 'Hide analytics' : 'Show analytics'}
          </Button>
        }
      >
        {analyticsExpanded && (
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
            <div id="kpi-runs" />
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
        )}
      </Section>

      <Modal
        isOpen={tradeoffOpen}
        onClose={() => setTradeoffOpen(false)}
        title="Customize KPI tradeoffs"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={handleTradeoffReset}>
              Reset to default
            </Button>
            <Button onClick={handleTradeoffSave}>Save</Button>
          </div>
        }
      >
        <div className="space-y-4">
          {TRADEOFF_DIMENSIONS.map((dimension) => (
            <div key={`tradeoff-picker-${dimension}`} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{dimension}</span>
              </div>
              <div className="space-y-2">
                {catalogOptions
                  .filter((kpi) => kpi.dimension === dimension || kpi.dimension === 'OTHER')
                  .map((kpi) => {
                  const checked = (tradeoffDraft[dimension] ?? resolvedSelections[dimension]) === kpi.name
                  return (
                    <label
                      key={`${dimension}-${kpi.name}`}
                      className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 px-3 py-2"
                    >
                      <input
                        type="radio"
                        name={`tradeoff-${dimension}`}
                        checked={checked}
                        onChange={() => {
                          const previous = tradeoffDraft[dimension] ?? resolvedSelections[dimension] ?? null
                          setTradeoffDraft((prev) => ({ ...prev, [dimension]: kpi.name }))
                          trackDashboardEvent('dashboard_tradeoff_kpi_changed', {
                            slot_dimension: dimension,
                            from_kpi: previous,
                            to_kpi: kpi.name,
                          })
                        }}
                      />
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-slate-900">{kpi.displayName}</span>
                          <Badge variant="neutral">{kpi.dimension}</Badge>
                        </div>
                        <p className="text-xs text-slate-500">{kpi.description}</p>
                      </div>
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  )
}
