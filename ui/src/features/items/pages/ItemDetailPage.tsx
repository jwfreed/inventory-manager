import { useQuery } from '@tanstack/react-query'
import { formatCurrency, formatDate, formatNumber } from '@shared/formatters'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { ApiError, Bom, BomVersion } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { Modal } from '../../../components/Modal'
import { useAuth } from '@shared/auth'
import { BomForm } from '../../boms/components/BomForm'
import { InventorySnapshotTable } from '../../inventory/components/InventorySnapshotTable'
import { useInventorySnapshotSummaryDetailed } from '../../inventory/queries'
import { useMovementWindow } from '../../ledger/queries'
import { useLocationsList } from '../../locations/queries'
import { getRoutingsByItemId } from '../../routings/api'
import { ItemForm } from '../components/ItemForm'
import { useUomConversionsList } from '../api/uomConversions'
import { useItem, useItemMetrics } from '../queries'
import { useBomsByItem } from '../../boms/queries'
import { BOMPanel } from '../components/BOMPanel'
import { ConfigurationHealthPill, ContextRail } from '../components/ContextRail'
import { ConfigurationPanels } from '../components/ConfigurationPanels'
import { ConversionPanel } from '../components/ConversionPanel'
import { InventoryLifecycle } from '../components/InventoryLifecycle'
import { ItemHeader } from '../components/ItemHeader'
import { ItemHealthBanner } from '../components/ItemHealthBanner'
import { ItemSectionNav } from '../components/ItemSectionNav'
import { MetricGrid } from '../components/MetricGrid'
import { MetricTile } from '../components/MetricTile'
import { RoutingPanel } from '../components/RoutingPanel'
import { useInventoryLifecycle } from '../hooks/useInventoryLifecycle'
import { useItemHealth } from '../hooks/useItemHealth'
import { useUnitConversions } from '../hooks/useUnitConversions'
import { normalizeUomCode, summarizeInventoryRows } from '../itemDetail.logic'
import { ItemHealthStatus } from '../itemDetail.models'

const sectionLinks = [
  { id: 'overview', label: 'Overview' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'production', label: 'Production' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'history', label: 'History' },
]

const inventoryStageOrder = [
  'Storage / Available',
  'Receiving & Staging',
  'Production / WIP',
  'Quarantine / Rejected',
  'External / Virtual',
] as const

const toDateInputValue = (value?: string | null) => {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return null
  return date.toISOString().slice(0, 10)
}

export default function ItemDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const baseCurrency = user?.baseCurrency ?? 'THB'
  const [searchParams, setSearchParams] = useSearchParams()
  const [showEdit, setShowEdit] = useState(false)
  const [showBomForm, setShowBomForm] = useState(false)
  const [showBomModal, setShowBomModal] = useState(false)
  const [bomDraftSource, setBomDraftSource] = useState<{
    bom?: Bom
    version?: BomVersion
  } | null>(null)
  const [bomMessage, setBomMessage] = useState<string | null>(null)
  const [idCopied, setIdCopied] = useState(false)
  const editFormRef = useRef<HTMLDivElement | null>(null)
  const copyTimeoutRef = useRef<number | null>(null)
  const selectedLocationId = searchParams.get('locationId') ?? ''

  const itemQuery = useItem(id, {
    retry: (count, err: ApiError) => err?.status !== 404 && count < 1,
  })
  const metricsQuery = useItemMetrics(id, 90, { enabled: Boolean(id) })
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

  useEffect(() => {
    if (itemQuery.isError && itemQuery.error?.status === 404) {
      navigate('/not-found', { replace: true })
    }
  }, [itemQuery.isError, itemQuery.error, navigate])

  useEffect(() => {
    if (!showEdit) return
    const node = editFormRef.current
    if (!node) return
    node.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const focusable = node.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input, textarea, select',
    )
    focusable?.focus()
  }, [showEdit])

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current != null) {
        window.clearTimeout(copyTimeoutRef.current)
      }
    }
  }, [])

  const item = itemQuery.data
  const stockRows = useMemo(() => inventoryQuery.data?.data ?? [], [inventoryQuery.data?.data])
  const diagnostics = useMemo(
    () => inventoryQuery.data?.diagnostics.uomNormalizationDiagnostics ?? [],
    [inventoryQuery.data?.diagnostics.uomNormalizationDiagnostics],
  )

  const movementLink = useMemo(() => {
    if (!id) return '/movements'
    const params = new URLSearchParams()
    params.set('itemId', id)
    if (selectedLocationId) {
      params.set('locationId', selectedLocationId)
    }
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
    const map = new Map<
      string,
      { code?: string; name?: string; type?: string; role?: string; isSellable?: boolean }
    >()
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
          diagnostics
            .filter((entry) => entry.reason === 'NON_CONVERTIBLE_UOM' || entry.status !== 'OK')
            .flatMap((entry) => entry.observedUoms),
        ),
      ),
    [diagnostics],
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
  const bomSummary = useMemo(() => {
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
  const lifecycleStages = useInventoryLifecycle(inventorySummary)

  const metricTiles = [
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
  ] as const

  const classifyLocationStage = useCallback(
    (locationId: string) => {
      const location = locationLookup.get(locationId)
      if (!location) return 'External / Virtual'
      const type = location.type?.toLowerCase() ?? ''
      if (location.role && location.role !== 'SELLABLE') return 'Quarantine / Rejected'
      if (location.isSellable === false) return 'Quarantine / Rejected'
      if (type.includes('receiv') || type.includes('stage')) return 'Receiving & Staging'
      if (type.includes('prod') || type.includes('wip') || type.includes('manufactur')) {
        return 'Production / WIP'
      }
      if (
        ['warehouse', 'bin', 'store'].includes(type) ||
        type.includes('warehouse') ||
        type.includes('bin') ||
        type.includes('store')
      ) {
        return 'Storage / Available'
      }
      return 'External / Virtual'
    },
    [locationLookup],
  )

  const stageRows = useMemo(() => {
    const groups = new Map<string, typeof stockRows>()
    stockRows.forEach((row) => {
      const stage = classifyLocationStage(row.locationId)
      const list = groups.get(stage) ?? []
      list.push(row)
      groups.set(stage, list)
    })
    return groups
  }, [classifyLocationStage, stockRows])

  const stageTotals = useMemo(() => {
    const groups = new Map<string, number>()
    stageRows.forEach((rows, stage) => {
      const total = rows.reduce((sum, row) => {
        const factor = conversionState.factorByUom.get(normalizeUomCode(row.uom)) ?? 0
        return sum + row.available * factor
      }, 0)
      groups.set(stage, total)
    })
    return groups
  }, [conversionState.factorByUom, stageRows])

  const copyId = async () => {
    if (!id) return
    try {
      await navigator.clipboard.writeText(id)
      setIdCopied(true)
      if (copyTimeoutRef.current != null) {
        window.clearTimeout(copyTimeoutRef.current)
      }
      copyTimeoutRef.current = window.setTimeout(() => setIdCopied(false), 1800)
    } catch {
      // ignore
    }
  }

  const updateLocationScope = (nextLocationId: string) => {
    const nextParams = new URLSearchParams(searchParams)
    if (nextLocationId) {
      nextParams.set('locationId', nextLocationId)
    } else {
      nextParams.delete('locationId')
    }
    setSearchParams(nextParams)
  }

  const openBomModal = (payload?: { bom?: Bom; version?: BomVersion }) => {
    setBomDraftSource(payload ?? null)
    setShowBomModal(true)
  }

  const closeBomModal = () => {
    setShowBomModal(false)
    setBomDraftSource(null)
  }

  const handleHealthAction = (actionId: string) => {
    switch (actionId) {
      case 'fix_conversions':
        document.getElementById('configuration')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        break
      case 'adjust_stock':
        if (id) navigate(`/inventory-adjustments/new?itemId=${id}`)
        break
      case 'create_bom':
        setShowBomForm(true)
        document.getElementById('production')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        break
      case 'create_routing':
        document.getElementById('production')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        break
      case 'view_movements':
        navigate(movementLink)
        break
      case 'edit_item':
        setShowEdit(true)
        break
      default:
        break
    }
  }

  return (
    <div className="mx-auto max-w-[1480px] space-y-6 pb-10">
      {itemQuery.isLoading ? <LoadingSpinner label="Loading item..." /> : null}
      {itemQuery.isError && itemQuery.error ? (
        <ErrorState error={itemQuery.error} onRetry={() => void itemQuery.refetch()} />
      ) : null}

      {item ? (
        <>
          <section id="overview" className="space-y-6">
            <ItemHeader
              item={item}
              onBack={() => navigate('/items')}
              onEdit={() => setShowEdit((value) => !value)}
              onAdjustStock={() => {
                if (id) navigate(`/inventory-adjustments/new?itemId=${id}`)
              }}
              onCopyId={copyId}
              idCopied={idCopied}
            />

            <ItemHealthBanner health={health} onAction={handleHealthAction} />

            <MetricGrid>
              {metricTiles.map((tile) => (
                <MetricTile
                  key={tile.label}
                  label={tile.label}
                  value={tile.value}
                  subtext={tile.subtext}
                  status={tile.status}
                />
              ))}
            </MetricGrid>
          </section>

          <ItemSectionNav sections={sectionLinks} />

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
            <main className="space-y-6">
              <PageSection
                id="inventory"
                title="Inventory"
                description="Lifecycle, scope, warnings, and stage-by-stage breakdown for the authoritative stock view."
              >
                <Card
                  title="Inventory lifecycle"
                  description="Normalized to the canonical unit when the system registry or item overrides can resolve conversions."
                  className="rounded-[24px] border-slate-200 shadow-sm shadow-slate-950/5"
                >
                  <InventoryLifecycle stages={lifecycleStages} uom={conversionState.canonicalUom} />
                </Card>

                <Card
                  title="Inventory state"
                  description="Inventory is grouped by operational stage and scoped by location."
                  action={
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <label
                        htmlFor="item-location-scope"
                        className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500"
                      >
                        Location scope
                      </label>
                      <select
                        id="item-location-scope"
                        className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                        value={selectedLocationId}
                        onChange={(event) => updateLocationScope(event.target.value)}
                      >
                        <option value="">All locations</option>
                        {locationsQuery.data?.data.map((location) => (
                          <option key={location.id} value={location.id}>
                            {location.code || location.name || 'Location'}
                          </option>
                        ))}
                      </select>
                      <Button variant="secondary" size="sm" onClick={() => navigate(movementLink)}>
                        View movements
                      </Button>
                    </div>
                  }
                  className="rounded-[24px] border-slate-200 shadow-sm shadow-slate-950/5"
                >
                  <div className="space-y-4">
                    <div className="text-sm text-slate-600">Scope: {selectedLocationLabel}</div>

                    {inventoryQuery.isLoading ? <LoadingSpinner label="Loading inventory..." /> : null}
                    {inventoryQuery.isError ? (
                      <ErrorState
                        error={inventoryQuery.error as ApiError}
                        onRetry={() => void inventoryQuery.refetch()}
                      />
                    ) : null}

                    {healthConfiguration.missingConversionUnits.length > 0 ? (
                      <Alert
                        variant="warning"
                        title="Missing UOM normalization"
                        message={`Inventory cannot be fully normalized for ${healthConfiguration.missingConversionUnits.join(', ')}.`}
                      />
                    ) : null}

                    {inventorySummary.hasNegativeOnHand ? (
                      <Alert
                        variant="warning"
                        title="Negative inventory detected"
                        message="Movement ordering is inconsistent for at least one stock row."
                        action={
                          <Button variant="secondary" size="sm" onClick={() => navigate(movementLink)}>
                            Investigate
                          </Button>
                        }
                      />
                    ) : null}

                    {stockRows.length === 0 && !inventoryQuery.isLoading ? (
                      <EmptyState
                        title="No stock activity yet"
                        description="This item has no on-hand, reservation, or inbound movement in the selected scope."
                        action={
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              if (id) navigate(`/inventory-adjustments/new?itemId=${id}`)
                            }}
                          >
                            Adjust stock
                          </Button>
                        }
                      />
                    ) : null}

                    <div className="space-y-4">
                      {inventoryStageOrder.map((stage) => {
                        const rows = stageRows.get(stage) ?? []
                        if (rows.length === 0) return null
                        return (
                          <div
                            key={stage}
                            className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/60"
                          >
                            <div className="border-b border-slate-200 px-5 py-4">
                              <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                                <div>
                                  <div className="text-base font-semibold text-slate-900">{stage}</div>
                                  <div className="mt-1 text-sm text-slate-600">
                                    Available {formatNumber(stageTotals.get(stage) ?? 0)}{' '}
                                    {conversionState.canonicalUom ?? ''}
                                  </div>
                                </div>
                              </div>
                            </div>
                            <div className="px-5 py-4">
                              <InventorySnapshotTable
                                rows={rows}
                                showItem={false}
                                showLocation={!selectedLocationId}
                                locationLookup={locationLookup}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </Card>
              </PageSection>

              <PageSection
                id="production"
                title="Production"
                description="Manufacturing definitions are kept in modular panels for BOMs and routings."
              >
                <ConfigurationPanels>
                  <BOMPanel
                    item={item}
                    summary={bomSummary}
                    boms={bomsQuery.data?.boms ?? []}
                    isLoading={bomsQuery.isLoading}
                    error={(bomsQuery.error as ApiError) ?? null}
                    showComposer={showBomForm}
                    message={bomMessage}
                    onToggleComposer={() => {
                      setShowBomForm((value) => !value)
                      if (!showBomForm) setBomMessage(null)
                    }}
                    onCreateWorkOrder={() => {
                      if (!bomSummary.activeBom || !id) return
                      navigate(`/work-orders/new?outputItemId=${id}&bomId=${bomSummary.activeBom.id}`)
                    }}
                    onCreated={() => {
                      setShowBomForm(false)
                      setBomMessage('BOM created.')
                      void bomsQuery.refetch()
                    }}
                    onRefetch={() => void bomsQuery.refetch()}
                    onDuplicate={openBomModal}
                  />
                  <RoutingPanel itemId={item.id} />
                </ConfigurationPanels>
              </PageSection>

              <PageSection
                id="configuration"
                title="Configuration"
                description="Unit conversions and master-data editing stay isolated from inventory and production read paths."
              >
                <ConfigurationPanels>
                  <ConversionPanel
                    item={item}
                    conversionState={conversionState}
                    manualConversions={uomConversionsQuery.data ?? []}
                  />

                  {showEdit ? (
                    <div ref={editFormRef}>
                      <Card
                        title="Edit item"
                        description="Inline editor for master data and default policies."
                        className="rounded-[24px] border-slate-200 shadow-sm shadow-slate-950/5"
                      >
                        <ItemForm
                          initialItem={item}
                          onSuccess={() => {
                            setShowEdit(false)
                            void itemQuery.refetch()
                          }}
                        />
                      </Card>
                    </div>
                  ) : null}
                </ConfigurationPanels>
              </PageSection>

              <PageSection
                id="history"
                title="History"
                description="Movement and change context without pulling metadata into the primary work surface."
              >
                <Card
                  title="Supporting history"
                  description="Use the movement ledger for detailed traceability and issue investigation."
                  action={
                    <Button variant="secondary" size="sm" onClick={() => navigate(movementLink)}>
                      View movement ledger
                    </Button>
                  }
                  className="rounded-[24px] border-slate-200 shadow-sm shadow-slate-950/5"
                >
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-4">
                      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Created
                      </div>
                      <div className="mt-2 text-base font-semibold text-slate-950">
                        {item.createdAt ? formatDate(item.createdAt) : '—'}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-4">
                      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Updated
                      </div>
                      <div className="mt-2 text-base font-semibold text-slate-950">
                        {item.updatedAt ? formatDate(item.updatedAt) : '—'}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-4">
                      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Costing
                      </div>
                      <div className="mt-2 text-base font-semibold text-slate-950">
                        {item.averageCost != null
                          ? formatCurrency(item.averageCost, baseCurrency)
                          : item.standardCost != null
                            ? formatCurrency(item.standardCost, item.standardCostCurrency ?? baseCurrency)
                            : 'Not set'}
                      </div>
                    </div>
                  </div>
                </Card>
              </PageSection>
            </main>

            <ContextRail
              sections={[
                {
                  title: 'Entity identity',
                  description: 'Stable properties for fast scanning.',
                  items: [
                    { label: 'Type', value: item.type },
                    { label: 'Lifecycle', value: item.lifecycleStatus },
                    { label: 'Default UOM', value: item.defaultUom || '—' },
                    { label: 'Canonical UOM', value: item.canonicalUom || '—' },
                    { label: 'Stocking UOM', value: item.stockingUom || '—' },
                    {
                      label: 'Default location',
                      value: item.defaultLocationCode || item.defaultLocationName || '—',
                    },
                  ],
                },
                {
                  title: 'Configuration health',
                  description: 'High-signal readiness checks.',
                  items: [
                    {
                      label: 'UOM normalization',
                      value: (
                        <ConfigurationHealthPill
                          label={
                            conversionState.mode === 'derived'
                              ? 'System derived'
                              : healthConfiguration.missingConversionUnits.length > 0
                                ? 'Manual required'
                                : 'Manual configured'
                          }
                          tone={
                            healthConfiguration.missingConversionUnits.length > 0 ? 'warning' : 'success'
                          }
                        />
                      ),
                    },
                    {
                      label: 'Active BOM',
                      value: (
                        <ConfigurationHealthPill
                          label={bomSummary.activeBom ? 'Ready' : hasManufacturingFlow ? 'Missing' : 'Optional'}
                          tone={bomSummary.activeBom || !hasManufacturingFlow ? 'success' : 'warning'}
                        />
                      ),
                    },
                    {
                      label: 'Routing',
                      value: (
                        <ConfigurationHealthPill
                          label={(routingsQuery.data?.length ?? 0) > 0 ? 'Ready' : hasManufacturingFlow ? 'Missing' : 'Optional'}
                          tone={(routingsQuery.data?.length ?? 0) > 0 || !hasManufacturingFlow ? 'success' : 'warning'}
                        />
                      ),
                    },
                  ],
                },
                {
                  title: 'Supporting metadata',
                  description: 'Secondary details kept out of the main flow.',
                  items: [
                    { label: 'Item ID', value: item.id },
                    { label: 'ABC class', value: item.abcClass || '—' },
                    {
                      label: 'Standard cost',
                      value:
                        item.standardCost != null
                          ? formatCurrency(item.standardCost, item.standardCostCurrency ?? baseCurrency)
                          : 'Not set',
                    },
                    {
                      label: `Base cost (${baseCurrency})`,
                      value:
                        item.standardCostBase != null
                          ? formatCurrency(item.standardCostBase, baseCurrency)
                          : '—',
                    },
                  ],
                },
              ]}
            />
          </div>
        </>
      ) : null}

      <Modal
        isOpen={showBomModal}
        onClose={closeBomModal}
        title={bomDraftSource ? 'New BOM version' : 'Create BOM'}
        className="max-h-[92vh] w-full max-w-[90vw] overflow-hidden"
      >
        <div className="max-h-[80vh] overflow-y-auto pr-4">
          {item ? (
            <BomForm
              outputItemId={item.id}
              defaultUom={item.defaultUom || undefined}
              initialBom={bomDraftSource ?? undefined}
              onSuccess={() => {
                closeBomModal()
                setBomMessage('BOM created.')
                void bomsQuery.refetch()
              }}
            />
          ) : null}
        </div>
      </Modal>
    </div>
  )
}

function PageSection({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section id={id} className="space-y-4 scroll-mt-24">
      <div className="space-y-1">
        <div className="text-2xl font-semibold tracking-tight text-slate-950">{title}</div>
        <p className="max-w-3xl text-sm leading-6 text-slate-600">{description}</p>
      </div>
      {children}
    </section>
  )
}
