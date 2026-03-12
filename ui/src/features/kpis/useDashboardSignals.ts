import { useMemo } from 'react'
import type {
  ApiError,
  DashboardOverview,
  DashboardSignalSection,
  InventoryUomInconsistency,
  Item,
  Location,
} from '@api/types'
import { useInventorySnapshotSummaryDetailed } from '@features/inventory/queries'
import { useItemsList, useItemsMetrics } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'
import { usePurchaseOrdersList } from '@features/purchaseOrders/queries'
import { useWorkOrdersList } from '@features/workOrders/queries'
import {
  bucketUomDiagnosticsByGroup,
  buildDashboardExceptions,
  buildDashboardSignals,
  deriveCoverageState,
  type MonitoringCoverage,
} from './dashboardMath'
import {
  useDashboardOverview,
  useFulfillmentFillRate,
  useReplenishmentPolicies,
  useReplenishmentRecommendations,
} from './queries'

const DEFAULT_WINDOW_DAYS = 90

function isNotFoundError(error: unknown): error is ApiError {
  return Boolean(error && typeof error === 'object' && (error as ApiError).status === 404)
}

function createEmptySection(
  key: DashboardSignalSection['key'],
  title: string,
  description: string,
): DashboardSignalSection {
  return {
    key,
    title,
    description,
    metrics: [],
    rows: [],
  }
}

function createEmptySections(): DashboardOverview['sections'] {
  return {
    inventoryIntegrity: createEmptySection(
      'inventoryIntegrity',
      'Inventory Integrity',
      'Compatibility fallback. Rebuild or restart the backend on the latest source to enable the server-owned overview.',
    ),
    inventoryRisk: createEmptySection('inventoryRisk', 'Inventory Risk', 'Compatibility fallback.'),
    inventoryCoverage: createEmptySection('inventoryCoverage', 'Inventory Coverage', 'Compatibility fallback.'),
    flowReliability: createEmptySection('flowReliability', 'Flow Reliability', 'Compatibility fallback.'),
    supplyReliability: createEmptySection('supplyReliability', 'Supply Reliability', 'Compatibility fallback.'),
    excessInventory: createEmptySection('excessInventory', 'Excess Inventory', 'Compatibility fallback.'),
    performanceMetrics: createEmptySection('performanceMetrics', 'Performance Metrics', 'Compatibility fallback.'),
    systemHealth: createEmptySection('systemHealth', 'System Health', 'Compatibility fallback.'),
    demandVolatility: createEmptySection('demandVolatility', 'Demand Volatility', 'Compatibility fallback.'),
    forecastAccuracy: createEmptySection('forecastAccuracy', 'Forecast Accuracy', 'Compatibility fallback.'),
  }
}

function formatAsOfLabel(asOfIso: string) {
  const date = new Date(asOfIso)
  if (Number.isNaN(date.getTime())) return asOfIso
  return date.toLocaleString()
}

function buildWarehouseLookup(locations: Location[]) {
  const map = new Map<string, { code?: string | null; name?: string | null }>()
  locations.forEach((location) => {
    if (location.type === 'warehouse') {
      map.set(location.id, { code: location.code, name: location.name })
    }
  })
  return map
}

function buildFallbackOverview(input: {
  items: Item[]
  locations: Location[]
  inventoryRows: NonNullable<ReturnType<typeof useInventorySnapshotSummaryDetailed>['data']>['data']
  uomDiagnostics: InventoryUomInconsistency[]
  policies: NonNullable<ReturnType<typeof useReplenishmentPolicies>['data']>['data']
  recommendations: NonNullable<ReturnType<typeof useReplenishmentRecommendations>['data']>['data']
  purchaseOrders: NonNullable<ReturnType<typeof usePurchaseOrdersList>['data']>['data']
  workOrders: NonNullable<ReturnType<typeof useWorkOrdersList>['data']>['data']
  itemMetrics: NonNullable<ReturnType<typeof useItemsMetrics>['data']>
  fillRate: ReturnType<typeof useFulfillmentFillRate>['data'] | null
}): DashboardOverview {
  const asOf = new Date().toISOString()
  const asOfLabel = formatAsOfLabel(asOf)
  const itemLookup = new Map(input.items.map((item) => [item.id, item]))
  const locationLookup = new Map(input.locations.map((location) => [location.id, location]))
  const itemMetricsLookup = new Map(input.itemMetrics.map((metric) => [metric.itemId, metric]))
  const policyScopeSet = new Set(
    input.policies
      .filter((policy) => policy.status !== 'inactive' && policy.siteLocationId)
      .map((policy) => `${policy.itemId}:${policy.siteLocationId}`),
  )

  const exceptions = buildDashboardExceptions({
    inventoryRows: input.inventoryRows,
    uomInconsistencies: input.uomDiagnostics,
    recommendations: input.recommendations,
    policyScopeSet,
    purchaseOrders: input.purchaseOrders,
    workOrders: input.workOrders,
    itemLookup,
    locationLookup,
    itemMetricsLookup,
    asOf,
  })

  const signals = buildDashboardSignals({
    exceptions,
    fillRate: input.fillRate ?? null,
    asOfLabel,
  })

  const coverage: MonitoringCoverage = deriveCoverageState({
    inventoryRows: input.inventoryRows,
    policies: input.policies,
    items: input.items,
    itemMetrics: input.itemMetrics,
    fillRate: input.fillRate ?? null,
  })

  const warehouseLookup = buildWarehouseLookup(input.locations)

  return {
    asOf,
    asOfLabel,
    warehouseScope: {
      ids: [],
      label: 'Warehouse scope not resolved',
    },
    warehouses: Array.from(warehouseLookup.entries()).map(([id, warehouse]) => ({
      id,
      code: warehouse.code ?? null,
      name: warehouse.name ?? null,
    })),
    coverage,
    exceptions,
    signals,
    uomNormalizationDiagnostics: input.uomDiagnostics,
    uomDiagnosticGroupBuckets: bucketUomDiagnosticsByGroup(input.uomDiagnostics),
    sections: createEmptySections(),
    coverageMatrix: [],
  }
}

export function useDashboardSignals() {
  const overviewQuery = useDashboardOverview(
    { windowDays: DEFAULT_WINDOW_DAYS },
    { staleTime: 30_000, retry: 1 },
  )

  const shouldUseCompatibilityFallback = isNotFoundError(overviewQuery.error)

  const inventorySummaryQuery = useInventorySnapshotSummaryDetailed(
    { limit: 5_000 },
    { enabled: shouldUseCompatibilityFallback, staleTime: 30_000, retry: 1 },
  )
  const itemsQuery = useItemsList(
    { limit: 1_000 },
    { enabled: shouldUseCompatibilityFallback, staleTime: 60_000, retry: 1 },
  )
  const locationsQuery = useLocationsList(
    { limit: 1_000 },
    { enabled: shouldUseCompatibilityFallback, staleTime: 60_000, retry: 1 },
  )
  const policiesQuery = useReplenishmentPolicies({
    enabled: shouldUseCompatibilityFallback,
    staleTime: 60_000,
    retry: 1,
  })
  const recommendationsQuery = useReplenishmentRecommendations(
    { limit: 1_000 },
    { enabled: shouldUseCompatibilityFallback, staleTime: 30_000, retry: 1 },
  )
  const purchaseOrdersQuery = usePurchaseOrdersList(
    { limit: 500 },
    { enabled: shouldUseCompatibilityFallback, staleTime: 30_000, retry: 1 },
  )
  const workOrdersQuery = useWorkOrdersList(
    { limit: 500 },
    { enabled: shouldUseCompatibilityFallback, staleTime: 30_000, retry: 1 },
  )
  const itemIds = itemsQuery.data?.data.map((item) => item.id) ?? []
  const itemMetricsQuery = useItemsMetrics(itemIds, DEFAULT_WINDOW_DAYS, {
    enabled: shouldUseCompatibilityFallback && itemIds.length > 0,
    staleTime: 30_000,
    retry: 1,
  })
  const fillRateQuery = useFulfillmentFillRate(
    {},
    { enabled: shouldUseCompatibilityFallback, staleTime: 30_000, retry: 1 },
  )

  const fallbackOverview = useMemo(() => {
    if (!shouldUseCompatibilityFallback) return null
    if (
      !inventorySummaryQuery.data ||
      !itemsQuery.data ||
      !locationsQuery.data ||
      !policiesQuery.data ||
      !recommendationsQuery.data ||
      !purchaseOrdersQuery.data ||
      !workOrdersQuery.data
    ) {
      return null
    }

    return buildFallbackOverview({
      items: itemsQuery.data.data,
      locations: locationsQuery.data.data,
      inventoryRows: inventorySummaryQuery.data.data,
      uomDiagnostics: inventorySummaryQuery.data.diagnostics.uomNormalizationDiagnostics,
      policies: policiesQuery.data.data,
      recommendations: recommendationsQuery.data.data,
      purchaseOrders: purchaseOrdersQuery.data.data,
      workOrders: workOrdersQuery.data.data,
      itemMetrics: itemMetricsQuery.data ?? [],
      fillRate: fillRateQuery.data ?? null,
    })
  }, [
    shouldUseCompatibilityFallback,
    inventorySummaryQuery.data,
    itemsQuery.data,
    locationsQuery.data,
    policiesQuery.data,
    recommendationsQuery.data,
    purchaseOrdersQuery.data,
    workOrdersQuery.data,
    itemMetricsQuery.data,
    fillRateQuery.data,
  ])

  const activeOverview = overviewQuery.data ?? fallbackOverview

  const warehouseLookup = useMemo(() => {
    const warehouses = activeOverview?.warehouses ?? []
    const map = new Map<string, { code?: string | null; name?: string | null }>()
    warehouses.forEach((warehouse) => {
      map.set(warehouse.id, { code: warehouse.code, name: warehouse.name })
    })
    return map
  }, [activeOverview?.warehouses])

  const fallbackLoading =
    shouldUseCompatibilityFallback &&
    !fallbackOverview &&
    [
      inventorySummaryQuery,
      itemsQuery,
      locationsQuery,
      policiesQuery,
      recommendationsQuery,
      purchaseOrdersQuery,
      workOrdersQuery,
      itemMetricsQuery,
      fillRateQuery,
    ].some((query) => query.isLoading || query.isFetching)

  const fallbackError = shouldUseCompatibilityFallback
    ? [
        inventorySummaryQuery.error,
        itemsQuery.error,
        locationsQuery.error,
        policiesQuery.error,
        recommendationsQuery.error,
        purchaseOrdersQuery.error,
        workOrdersQuery.error,
        itemMetricsQuery.error,
        fillRateQuery.error,
      ].find((error) => error && !isNotFoundError(error))
    : undefined

  return {
    queries: {
      overviewQuery,
      inventorySummaryQuery,
      itemsQuery,
      locationsQuery,
      policiesQuery,
      recommendationsQuery,
      purchaseOrdersQuery,
      workOrdersQuery,
      itemMetricsQuery,
      fillRateQuery,
    },
    data: {
      asOfIso: activeOverview?.asOf ?? new Date().toISOString(),
      asOfLabel: activeOverview?.asOfLabel ?? '',
      exceptions: activeOverview?.exceptions ?? [],
      signals: activeOverview?.signals ?? [],
      coverage:
        activeOverview?.coverage ?? {
          hasInventoryRows: false,
          hasReplenishmentPolicies: false,
          hasDemandSignal: false,
          hasCycleCountProgram: false,
          hasShipmentsInWindow: false,
          inventoryMonitoringConfigured: false,
          replenishmentMonitoringConfigured: false,
          cycleCountMonitoringConfigured: false,
          reliabilityMeasurable: false,
        },
      sections: activeOverview?.sections,
      coverageMatrix: activeOverview?.coverageMatrix ?? [],
      warehouseScope: activeOverview?.warehouseScope,
      warehouseLookup,
      uomNormalizationDiagnostics: activeOverview?.uomNormalizationDiagnostics ?? [],
      uomDiagnosticGroupBuckets: activeOverview?.uomDiagnosticGroupBuckets ?? {
        actionGroups: 0,
        watchGroups: 0,
        totalGroups: 0,
      },
      uomInconsistencies: activeOverview?.uomNormalizationDiagnostics ?? [],
    },
    loading: overviewQuery.isLoading || fallbackLoading,
    error: shouldUseCompatibilityFallback
      ? (fallbackError as ApiError | undefined)
      : (overviewQuery.error as ApiError | undefined),
  }
}
