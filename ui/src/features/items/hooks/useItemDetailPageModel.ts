import { useQuery } from '@tanstack/react-query'
import { formatDate, formatNumber } from '@shared/formatters'
import { useMemo } from 'react'
import type { ApiError, Bom, BomVersion } from '../../../api/types'
import { useInventorySnapshotSummaryDetailed } from '../../inventory/queries'
import { useMovementWindow } from '../../ledger/queries'
import { useLocationsList } from '../../locations/queries'
import { getRoutingsByItemId } from '../../routings/api'
import { useBomsByItem } from '../../boms/queries'
import { useUomConversionsList } from '../api/uomConversions'
import { useInventoryDiagnostics } from './useInventoryDiagnostics'
import { useInventoryLifecycle } from './useInventoryLifecycle'
import { useItemHealth } from './useItemHealth'
import { useUnitConversions } from './useUnitConversions'
import { summarizeInventoryRows } from '../itemDetail.logic'
import type { MetricTileModel } from '../itemDetail.models'
import { ItemHealthStatus } from '../itemDetail.models'
import { useItem, useItemMetrics } from '../queries'

const WINDOW_DAYS = 90

export const itemDetailSectionLinks = [
  { id: 'overview', label: 'Overview' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'production', label: 'Production' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'history', label: 'History' },
]

const toDateInputValue = (value?: string | null) => {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return null
  return date.toISOString().slice(0, 10)
}

export type ItemDetailBomSummary = {
  activeBom?: Bom
  activeVersion?: BomVersion
  versionCount: number
}

export type ItemLocationMeta = {
  code?: string
  name?: string
  type?: string
  role?: string
  isSellable?: boolean
}

type Params = {
  id?: string
  selectedLocationId: string
}

export function useItemDetailPageModel({ id, selectedLocationId }: Params) {
  const itemQuery = useItem(id, {
    retry: (count, err: ApiError) => err?.status !== 404 && count < 1,
  })
  const metricsQuery = useItemMetrics(id, WINDOW_DAYS, { enabled: Boolean(id) })
  const bomsQuery = useBomsByItem(id)
  const uomConversionsQuery = useUomConversionsList(id)
  const locationsQuery = useLocationsList({ active: true, limit: 100 }, { staleTime: 60_000 })
  const inventoryQuery = useInventorySnapshotSummaryDetailed(
    {
      itemId: id ?? undefined,
      locationId: selectedLocationId || undefined,
      limit: 500,
    },
    { enabled: Boolean(id), staleTime: 30_000 },
  )
  const movementWindowQuery = useMovementWindow(
    { itemId: id ?? undefined, locationId: selectedLocationId || undefined },
    { staleTime: 30_000 },
  )
  const routingsQuery = useQuery({
    queryKey: ['routings', id],
    queryFn: () => getRoutingsByItemId(id as string),
    enabled: Boolean(id),
    staleTime: 30_000,
  })

  const item = itemQuery.data
  const stockRows = useMemo(() => inventoryQuery.data?.data ?? [], [inventoryQuery.data?.data])
  const normalizationDiagnostics = useMemo(
    () => inventoryQuery.data?.diagnostics.uomNormalizationDiagnostics ?? [],
    [inventoryQuery.data?.diagnostics.uomNormalizationDiagnostics],
  )

  const movementLink = useMemo(() => {
    if (!id) return '/movements'
    const params = new URLSearchParams()
    params.set('itemId', id)
    if (selectedLocationId) params.set('locationId', selectedLocationId)
    const occurredFrom = toDateInputValue(movementWindowQuery.data?.occurredFrom)
    const occurredTo = toDateInputValue(movementWindowQuery.data?.occurredTo)
    if (occurredFrom) params.set('occurredFrom', occurredFrom)
    if (occurredTo) params.set('occurredTo', occurredTo)
    return `/movements?${params.toString()}`
  }, [
    id,
    movementWindowQuery.data?.occurredFrom,
    movementWindowQuery.data?.occurredTo,
    selectedLocationId,
  ])

  const locationLookup = useMemo(() => {
    const map = new Map<string, ItemLocationMeta>()
    locationsQuery.data?.data?.forEach((location) => {
      map.set(location.id, {
        code: location.code,
        name: location.name,
        type: location.type,
        role: location.role,
        isSellable: location.isSellable,
      })
    })
    return map
  }, [locationsQuery.data])

  const selectedLocationLabel = useMemo(() => {
    if (!selectedLocationId) return 'All locations'
    const location = locationsQuery.data?.data.find((row) => row.id === selectedLocationId)
    if (!location) return 'Unknown location'
    return location.name ? `${location.code} — ${location.name}` : location.code
  }, [locationsQuery.data, selectedLocationId])

  const conversionQuery = useUnitConversions({
    item,
    stockRows,
    conversions: uomConversionsQuery.data ?? [],
  })
  const conversionState = conversionQuery.data

  const diagnosticMissingUnits = useMemo(
    () =>
      Array.from(
        new Set(
          normalizationDiagnostics
            .filter((entry) => entry.reason === 'NON_CONVERTIBLE_UOM' || entry.status !== 'OK')
            .flatMap((entry) => entry.observedUoms),
        ),
      ),
    [normalizationDiagnostics],
  )

  const inventorySummary = useMemo(
    () =>
      summarizeInventoryRows(
        stockRows,
        conversionState.factorByUom,
        conversionState.canonicalUom,
      ),
    [conversionState.canonicalUom, conversionState.factorByUom, stockRows],
  )

  const hasManufacturingFlow = item?.type === 'wip' || item?.type === 'finished'
  const bomSummary = useMemo<ItemDetailBomSummary>(() => {
    const boms = bomsQuery.data?.boms ?? []
    const activeBom = boms.find((bom) => bom.versions.some((version) => version.status === 'active'))
    const activeVersion = activeBom?.versions.find((version) => version.status === 'active')
    const versionCount = boms.reduce((sum, bom) => sum + bom.versions.length, 0)
    return { activeBom, activeVersion, versionCount }
  }, [bomsQuery.data?.boms])

  const healthConfiguration = useMemo(
    () => ({
      hasActiveBom: Boolean(bomSummary.activeBom),
      requiresBom: hasManufacturingFlow,
      hasRouting: (routingsQuery.data?.length ?? 0) > 0,
      requiresRouting: hasManufacturingFlow,
      conversionMode: conversionState.mode,
      systemConversionDetected: conversionState.systemDetected,
      missingConversionUnits: Array.from(
        new Set([...conversionState.missingUnits, ...diagnosticMissingUnits]),
      ),
    }),
    [
      bomSummary.activeBom,
      conversionState.missingUnits,
      conversionState.mode,
      conversionState.systemDetected,
      diagnosticMissingUnits,
      hasManufacturingFlow,
      routingsQuery.data,
    ],
  )

  const health = useItemHealth({
    item,
    inventory: inventorySummary,
    configuration: healthConfiguration,
  })
  const diagnostics = useInventoryDiagnostics({
    item,
    inventory: inventorySummary,
    stockRows,
    conversions: conversionState,
  })
  const lifecycleStages = useInventoryLifecycle(inventorySummary)

  const metricTiles = useMemo<MetricTileModel[]>(
    () => [
      {
        label: 'Available now',
        value: conversionState.canonicalUom
          ? `${formatNumber(inventorySummary.available)} ${conversionState.canonicalUom}`
          : '—',
        subtext: `Scope: ${selectedLocationLabel}`,
        status: inventorySummary.available > 0 ? 'neutral' : 'warning',
      },
      {
        label: 'On hand',
        value: conversionState.canonicalUom
          ? `${formatNumber(inventorySummary.onHand)} ${conversionState.canonicalUom}`
          : stockRows.length,
        subtext:
          metricsQuery.data?.lastCountAt != null
            ? `Last count ${formatDate(metricsQuery.data.lastCountAt)}`
            : 'Authoritative movement-ledger rollup',
        status: inventorySummary.hasNegativeOnHand ? 'danger' : 'neutral',
      },
      {
        label: 'Inventory position',
        value: conversionState.canonicalUom
          ? `${formatNumber(inventorySummary.inventoryPosition)} ${conversionState.canonicalUom}`
          : '—',
        subtext:
          inventorySummary.backordered > 0
            ? `Backordered ${formatNumber(inventorySummary.backordered)}`
            : 'Planning position',
        status: inventorySummary.backordered > 0 ? 'warning' : 'neutral',
      },
      {
        label: 'Manufacturing readiness',
        value:
          health.status === ItemHealthStatus.READY
            ? 'Ready'
            : bomSummary.activeBom
              ? 'Partial'
              : 'Blocked',
        subtext: bomSummary.activeBom
          ? `BOM ${bomSummary.activeBom.bomCode}`
          : hasManufacturingFlow
            ? 'No active BOM'
            : 'No BOM required',
        status: health.status === ItemHealthStatus.READY ? 'neutral' : 'warning',
      },
    ],
    [
      bomSummary.activeBom,
      conversionState.canonicalUom,
      hasManufacturingFlow,
      health.status,
      inventorySummary.available,
      inventorySummary.backordered,
      inventorySummary.hasNegativeOnHand,
      inventorySummary.inventoryPosition,
      inventorySummary.onHand,
      metricsQuery.data?.lastCountAt,
      selectedLocationLabel,
      stockRows.length,
    ],
  )

  return {
    itemQuery,
    metricsQuery,
    bomsQuery,
    uomConversionsQuery,
    locationsQuery,
    inventoryQuery,
    routingsQuery,
    item,
    stockRows,
    movementLink,
    locationLookup,
    selectedLocationLabel,
    conversionState,
    inventorySummary,
    hasManufacturingFlow,
    bomSummary,
    healthConfiguration,
    health,
    diagnostics,
    lifecycleStages,
    metricTiles,
  }
}
