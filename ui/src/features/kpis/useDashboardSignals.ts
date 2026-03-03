import { useMemo } from 'react'
import type { ApiError } from '@api/types'
import { useInventorySnapshotSummary } from '@features/inventory/queries'
import { useItemsList, useItemsMetrics } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'
import { usePurchaseOrdersList } from '@features/purchaseOrders/queries'
import { useWorkOrdersList } from '@features/workOrders/queries'
import { formatDateTime } from './utils'
import { buildDashboardExceptions, buildDashboardSignals } from './dashboardMath'
import { useFulfillmentFillRate, useReplenishmentRecommendations } from './queries'

export function useDashboardSignals() {
  const inventorySummaryQuery = useInventorySnapshotSummary({ limit: 2000 }, { staleTime: 30_000 })
  const itemsQuery = useItemsList({ limit: 500 }, { staleTime: 60_000 })
  const locationsQuery = useLocationsList({ limit: 1000, active: true }, { staleTime: 60_000 })
  const purchaseOrdersQuery = usePurchaseOrdersList({ limit: 1000 }, { staleTime: 30_000 })
  const workOrdersQuery = useWorkOrdersList({ limit: 1000 }, { staleTime: 30_000 })
  const recommendationsQuery = useReplenishmentRecommendations({ limit: 1000 }, { staleTime: 30_000 })
  const fillRateQuery = useFulfillmentFillRate({}, { staleTime: 30_000 })

  const itemIds = useMemo(
    () => (itemsQuery.data?.data ?? []).map((item) => item.id),
    [itemsQuery.data],
  )
  const itemMetricsQuery = useItemsMetrics(itemIds, 90, {
    staleTime: 60_000,
    enabled: itemIds.length > 0,
  })

  const itemLookup = useMemo(() => {
    const map = new Map((itemsQuery.data?.data ?? []).map((item) => [item.id, item]))
    return map
  }, [itemsQuery.data])

  const locationLookup = useMemo(() => {
    const map = new Map((locationsQuery.data?.data ?? []).map((location) => [location.id, location]))
    return map
  }, [locationsQuery.data])

  const itemMetricsLookup = useMemo(() => {
    const map = new Map((itemMetricsQuery.data ?? []).map((metric) => [metric.itemId, metric]))
    return map
  }, [itemMetricsQuery.data])

  const asOfMs = useMemo(() => {
    const stamps = [
      inventorySummaryQuery.dataUpdatedAt,
      recommendationsQuery.dataUpdatedAt,
      purchaseOrdersQuery.dataUpdatedAt,
      workOrdersQuery.dataUpdatedAt,
      itemMetricsQuery.dataUpdatedAt,
      fillRateQuery.dataUpdatedAt,
    ].filter((value) => Number.isFinite(value) && value > 0)
    return stamps.length > 0 ? Math.max(...stamps) : Date.now()
  }, [
    inventorySummaryQuery.dataUpdatedAt,
    recommendationsQuery.dataUpdatedAt,
    purchaseOrdersQuery.dataUpdatedAt,
    workOrdersQuery.dataUpdatedAt,
    itemMetricsQuery.dataUpdatedAt,
    fillRateQuery.dataUpdatedAt,
  ])
  const asOfIso = new Date(asOfMs).toISOString()
  const asOfLabel = formatDateTime(asOfIso) || asOfIso

  const exceptions = useMemo(
    () =>
      buildDashboardExceptions({
        inventoryRows: inventorySummaryQuery.data ?? [],
        recommendations: recommendationsQuery.data?.data ?? [],
        purchaseOrders: purchaseOrdersQuery.data?.data ?? [],
        workOrders: workOrdersQuery.data?.data ?? [],
        itemLookup,
        locationLookup,
        itemMetricsLookup,
        asOf: asOfIso,
      }),
    [
      inventorySummaryQuery.data,
      recommendationsQuery.data,
      purchaseOrdersQuery.data,
      workOrdersQuery.data,
      itemLookup,
      locationLookup,
      itemMetricsLookup,
      asOfIso,
    ],
  )

  const signals = useMemo(
    () =>
      buildDashboardSignals({
        exceptions,
        fillRate: fillRateQuery.data ?? null,
        asOfLabel,
      }),
    [exceptions, fillRateQuery.data, asOfLabel],
  )

  const loading =
    inventorySummaryQuery.isLoading ||
    recommendationsQuery.isLoading ||
    purchaseOrdersQuery.isLoading ||
    workOrdersQuery.isLoading ||
    itemsQuery.isLoading ||
    locationsQuery.isLoading ||
    itemMetricsQuery.isLoading ||
    fillRateQuery.isLoading

  const error = [
    inventorySummaryQuery.error,
    recommendationsQuery.error,
    purchaseOrdersQuery.error,
    workOrdersQuery.error,
    itemsQuery.error,
    locationsQuery.error,
    itemMetricsQuery.error,
    fillRateQuery.error,
  ].find(Boolean) as ApiError | undefined

  return {
    queries: {
      inventorySummaryQuery,
      recommendationsQuery,
      purchaseOrdersQuery,
      workOrdersQuery,
      itemsQuery,
      locationsQuery,
      itemMetricsQuery,
      fillRateQuery,
    },
    data: {
      asOfIso,
      asOfLabel,
      itemLookup,
      locationLookup,
      exceptions,
      signals,
    },
    loading,
    error,
  }
}
