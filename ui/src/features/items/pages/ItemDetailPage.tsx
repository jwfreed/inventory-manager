import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useItem, useItemMetrics } from '../queries'
import { useLocationsList } from '../../locations/queries'
import { useInventorySnapshotSummary } from '../../inventory/queries'
import { useBomsByItem } from '../../boms/queries'
import { useUomConversionsList } from '../api/uomConversions'
import type { ApiError, Bom, BomVersion } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { Modal } from '../../../components/Modal'
import { Section } from '../../../components/Section'
import { formatCurrency, formatDate, formatNumber } from '@shared/formatters'
import { ItemForm } from '../components/ItemForm'
import { BomForm } from '../../boms/components/BomForm'
import { BomCard } from '../../boms/components/BomCard'
import { InventorySnapshotTable } from '../../inventory/components/InventorySnapshotTable'
import { UomConversionsCard } from '../components/UomConversionsCard'
import { RoutingsCard } from '../../routings/components/RoutingsCard'
import { useAuth } from '@shared/auth'

const typeLabels: Record<string, string> = {
  raw: 'Raw',
  wip: 'WIP',
  finished: 'Finished',
  packaging: 'Packaging',
}

export default function ItemDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const baseCurrency = user?.baseCurrency ?? 'THB'
  const [searchParams, setSearchParams] = useSearchParams()
  const [showEdit, setShowEdit] = useState(false)
  const [showRawUnits, setShowRawUnits] = useState(false)
  const [showBomForm, setShowBomForm] = useState(false)
  const [showBomModal, setShowBomModal] = useState(false)
  const [bomDraftSource, setBomDraftSource] = useState<{
    bom?: Bom
    version?: BomVersion
  } | null>(null)
  const [bomMessage, setBomMessage] = useState<string | null>(null)
  const [selectedLocationId, setSelectedLocationId] = useState(
    () => searchParams.get('locationId') ?? '',
  )
  const editFormRef = useRef<HTMLDivElement | null>(null)

  const itemQuery = useItem(id, {
    retry: (count, err: ApiError) => err?.status !== 404 && count < 1,
  })
  const metricsQuery = useItemMetrics(id, 90, { enabled: Boolean(id) })

  const locationsQuery = useLocationsList({ active: true, limit: 100 }, { staleTime: 60_000 })

  const snapshotQuery = useInventorySnapshotSummary(
    {
      itemId: id ?? undefined,
      locationId: selectedLocationId || undefined,
      limit: 500,
    },
    { enabled: Boolean(id), staleTime: 30_000 },
  )

  const bomsQuery = useBomsByItem(id)

  const uomConversionsQuery = useUomConversionsList(id)

  useEffect(() => {
    if (itemQuery.isError && itemQuery.error?.status === 404) {
      navigate('/not-found', { replace: true })
    }
  }, [itemQuery.isError, itemQuery.error, navigate])

  useEffect(() => {
    const locationId = searchParams.get('locationId') ?? ''
    setSelectedLocationId(locationId)
  }, [searchParams])

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

  const copyId = async () => {
    if (!id) return
    try {
      await navigator.clipboard.writeText(id)
    } catch {
      // ignore
    }
  }

  const stockRows = useMemo(() => snapshotQuery.data ?? [], [snapshotQuery.data])
  const defaultUom =
    itemQuery.data?.defaultUom?.trim() ||
    itemQuery.data?.canonicalUom?.trim() ||
    null
  const locationLookup = useMemo(() => {
    const map = new Map<string, { code?: string; name?: string; type?: string }>()
    locationsQuery.data?.data?.forEach((loc) => {
      map.set(loc.id, { code: loc.code, name: loc.name, type: loc.type })
    })
    return map
  }, [locationsQuery.data])
  const conversionPairs = useMemo(() => {
    const map = new Map<string, number>()
    ;(uomConversionsQuery.data ?? []).forEach((conversion) => {
      const fromKey = conversion.fromUom.trim().toLowerCase()
      const toKey = conversion.toUom.trim().toLowerCase()
      map.set(`${fromKey}:${toKey}`, conversion.factor)
    })
    return map
  }, [uomConversionsQuery.data])

  const getConversionFactor = (fromUom?: string | null, toUom?: string | null) => {
    if (!fromUom || !toUom) return null
    const fromKey = fromUom.trim().toLowerCase()
    const toKey = toUom.trim().toLowerCase()
    if (!fromKey || !toKey) return null
    if (fromKey === toKey) return 1
    const direct = conversionPairs.get(`${fromKey}:${toKey}`)
    if (direct) return direct
    const reverse = conversionPairs.get(`${toKey}:${fromKey}`)
    if (reverse) return 1 / reverse
    return null
  }

  const conversionMissingUoms = useMemo(() => {
    if (!defaultUom) return new Set<string>()
    const missing = new Set<string>()
    stockRows.forEach((row) => {
      if (row.isLegacy) return
      if (getConversionFactor(row.uom, defaultUom) == null) {
        missing.add(row.uom)
      }
    })
    return missing
  }, [defaultUom, stockRows, conversionPairs])

  const convertedRows = useMemo(() => {
    if (!defaultUom) return []
    const map = new Map<string, typeof stockRows[number]>()
    stockRows.forEach((row) => {
      if (row.isLegacy) return
      const factor = getConversionFactor(row.uom, defaultUom)
      if (factor == null) return
      const key = row.locationId
      const current = map.get(key) ?? {
        ...row,
        uom: defaultUom,
        onHand: 0,
        reserved: 0,
        available: 0,
        held: 0,
        rejected: 0,
        nonUsable: 0,
        onOrder: 0,
        inTransit: 0,
        backordered: 0,
        inventoryPosition: 0,
        isLegacy: false,
      }
      current.onHand += row.onHand * factor
      current.reserved += row.reserved * factor
      current.available += row.available * factor
      current.held += row.held * factor
      current.rejected += row.rejected * factor
      current.nonUsable += row.nonUsable * factor
      current.onOrder += row.onOrder * factor
      current.inTransit += row.inTransit * factor
      current.backordered += row.backordered * factor
      current.inventoryPosition += row.inventoryPosition * factor
      map.set(key, current)
    })
    return Array.from(map.values())
  }, [defaultUom, stockRows, conversionPairs])

  const totalsByDefaultUom = useMemo(() => {
    if (!defaultUom) return null
    return convertedRows.reduce(
      (acc, row) => ({
        onHand: acc.onHand + row.onHand,
        available: acc.available + row.available,
        reserved: acc.reserved + row.reserved,
        held: acc.held + row.held,
        rejected: acc.rejected + row.rejected,
        nonUsable: acc.nonUsable + row.nonUsable,
        onOrder: acc.onOrder + row.onOrder,
        inTransit: acc.inTransit + row.inTransit,
        backordered: acc.backordered + row.backordered,
        inventoryPosition: acc.inventoryPosition + row.inventoryPosition,
      }),
      {
        onHand: 0,
        available: 0,
        reserved: 0,
        held: 0,
        rejected: 0,
        nonUsable: 0,
        onOrder: 0,
        inTransit: 0,
        backordered: 0,
        inventoryPosition: 0,
      },
    )
  }, [convertedRows, defaultUom])

  const hasNegativeBalance = useMemo(
    () =>
      convertedRows.some((row) => row.onHand < 0 || row.available < 0),
    [convertedRows],
  )
  const hasNegativeRaw = useMemo(
    () => stockRows.some((row) => row.onHand < 0 || row.available < 0),
    [stockRows],
  )

  const locationStageLabel = useCallback(
    (locationId: string) => {
      const loc = locationLookup.get(locationId)
      const code = loc?.code?.toLowerCase() ?? ''
      const name = loc?.name?.toLowerCase() ?? ''
      const type = loc?.type ?? ''
      const haystack = `${code} ${name}`
      if (['scrap'].includes(type) || /scrap|reject|rejected/.test(haystack)) {
        return 'Quarantine / Rejected'
      }
      if (/qc|hold|quarantine/.test(haystack)) {
        return 'Quarantine / Rejected'
      }
      if (/receiv|staging/.test(haystack)) {
        return 'Receiving & Staging'
      }
      if (/wip|work|production/.test(haystack)) {
        return 'Production / WIP'
      }
      if (['warehouse', 'bin', 'store'].includes(type)) {
        return 'Storage / Available'
      }
      return 'External / Virtual'
    },
    [locationLookup],
  )

  const groupedRows = useMemo(() => {
    const groups = new Map<string, typeof convertedRows>()
    convertedRows.forEach((row) => {
      const stage = locationStageLabel(row.locationId)
      const list = groups.get(stage) ?? []
      list.push(row)
      groups.set(stage, list)
    })
    return groups
  }, [convertedRows, locationStageLabel])

  const stageTotals = useMemo(() => {
    const totals = new Map<string, { available: number; held: number; rejected: number; reserved: number }>()
    groupedRows.forEach((rows, stage) => {
      const accum = rows.reduce(
        (acc, row) => ({
          available: acc.available + row.available,
          held: acc.held + row.held,
          rejected: acc.rejected + row.rejected,
          reserved: acc.reserved + row.reserved,
        }),
        { available: 0, held: 0, rejected: 0, reserved: 0 },
      )
      totals.set(stage, accum)
    })
    return totals
  }, [groupedRows])
  const selectedLocationLabel = useMemo(() => {
    if (!selectedLocationId) return 'All locations'
    const loc = locationsQuery.data?.data.find((row) => row.id === selectedLocationId)
    if (!loc) return 'Unknown location'
    const code = loc.code ?? 'Location'
    return loc.name ? `${code} — ${loc.name}` : code
  }, [locationsQuery.data, selectedLocationId])

  const hasConversionIssues = conversionMissingUoms.size > 0
  const storageTotals = stageTotals.get('Storage / Available') ?? {
    available: 0,
    held: 0,
    rejected: 0,
    reserved: 0,
  }
  const receivingTotals = stageTotals.get('Receiving & Staging') ?? {
    available: 0,
    held: 0,
    rejected: 0,
    reserved: 0,
  }
  const wipTotals = stageTotals.get('Production / WIP') ?? {
    available: 0,
    held: 0,
    rejected: 0,
    reserved: 0,
  }
  const externalTotals = stageTotals.get('External / Virtual') ?? {
    available: 0,
    held: 0,
    rejected: 0,
    reserved: 0,
  }
  const totalHolds = (stageTotals.get('Quarantine / Rejected')?.held ?? 0) + (stageTotals.get('Quarantine / Rejected')?.rejected ?? 0)
  const totalReserved = totalsByDefaultUom?.reserved ?? 0
  const hasNegativeAny = hasNegativeBalance || (!defaultUom && hasNegativeRaw)
  const isUsable = storageTotals.available > 0 && !hasNegativeAny
  const operationalStatusTitle = isUsable ? '✔ Available for use' : '⚠ Not available for use'
  const stageOrder = [
    'Storage / Available',
    'Receiving & Staging',
    'Production / WIP',
    'Quarantine / Rejected',
    'External / Virtual',
  ]

  const bomSummary = useMemo(() => {
    const boms = bomsQuery.data?.boms ?? []
    const activeBom = boms.find((bom) => bom.versions.some((version) => version.status === 'active'))
    const activeVersion = activeBom?.versions.find((version) => version.status === 'active')
    const versionCount = boms.reduce((sum, bom) => sum + bom.versions.length, 0)
    return { activeBom, activeVersion, versionCount }
  }, [bomsQuery.data?.boms])

  const openBomModal = (source?: { bom?: Bom; version?: BomVersion }) => {
    setBomDraftSource(source ?? null)
    setShowBomModal(true)
  }

  const closeBomModal = () => {
    setShowBomModal(false)
    setBomDraftSource(null)
  }

  const updateLocationScope = (nextLocationId: string) => {
    setSelectedLocationId(nextLocationId)
    const nextParams = new URLSearchParams(searchParams)
    if (nextLocationId) {
      nextParams.set('locationId', nextLocationId)
    } else {
      nextParams.delete('locationId')
    }
    setSearchParams(nextParams)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Master data</p>
          <h2 className="text-2xl font-semibold text-slate-900">Item detail</h2>
          {itemQuery.data && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-700">
              <span className="font-semibold text-slate-900">
                {itemQuery.data.sku} — {itemQuery.data.name}
              </span>
              <Badge
                variant={
                  itemQuery.data.lifecycleStatus === 'Active'
                    ? 'success'
                    : itemQuery.data.lifecycleStatus === 'Obsolete' ||
                      itemQuery.data.lifecycleStatus === 'Phase-Out'
                    ? 'danger'
                    : 'neutral'
                }
              >
                {itemQuery.data.lifecycleStatus}
              </Badge>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate('/items')}>
            Back to list
          </Button>
          <Button
            variant={hasNegativeAny ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => {
              if (id) navigate(`/inventory-adjustments/new?itemId=${id}`)
            }}
          >
            Adjust stock
          </Button>
        </div>
      </div>

      {itemQuery.isLoading && <LoadingSpinner label="Loading item..." />}
      {itemQuery.isError && itemQuery.error && (
        <ErrorState error={itemQuery.error} onRetry={() => void itemQuery.refetch()} />
      )}

      {itemQuery.data && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">SKU</div>
              <div className="text-xl font-semibold text-slate-900">{itemQuery.data.sku}</div>
              <div className="text-sm text-slate-700">{itemQuery.data.name}</div>
              <button
                type="button"
                className="mt-1 text-xs font-semibold text-slate-500 underline"
                onClick={copyId}
              >
                Copy item ID
              </button>
              {itemQuery.data.description && (
                <div className="mt-2 text-sm text-slate-600">{itemQuery.data.description}</div>
              )}
              <div className="mt-3 grid gap-3 sm:grid-cols-3 text-sm text-slate-700">
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Type</div>
                  <div className="font-semibold text-slate-900">
                    {typeLabels[itemQuery.data.type] ?? itemQuery.data.type}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Default UOM</div>
                  <div className="font-semibold text-slate-900">
                    {itemQuery.data.defaultUom || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Default location</div>
                  <div className="font-semibold text-slate-900">
                    {itemQuery.data.defaultLocationCode ||
                      itemQuery.data.defaultLocationName ||
                      '—'}
                  </div>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-slate-200 grid gap-3 sm:grid-cols-4 text-sm text-slate-700">
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Standard Cost</div>
                  <div className="text-[11px] text-slate-500">Variance reporting</div>
                  <div className="font-mono font-semibold text-slate-900">
                    {itemQuery.data.standardCost != null
                      ? formatCurrency(
                          itemQuery.data.standardCost,
                          itemQuery.data.standardCostCurrency ?? baseCurrency,
                        )
                      : 'Not set'}
                  </div>
                  {itemQuery.data.standardCostCurrency &&
                  itemQuery.data.standardCostExchangeRateToBase &&
                  itemQuery.data.standardCostCurrency !== baseCurrency ? (
                    <div className="text-xs text-slate-500">
                      Rate: {formatNumber(itemQuery.data.standardCostExchangeRateToBase)}
                    </div>
                  ) : null}
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">
                    Base Cost ({baseCurrency})
                  </div>
                  <div className="text-[11px] text-slate-500">Reference currency</div>
                  <div className="font-mono font-semibold text-slate-900">
                    {itemQuery.data.standardCostBase != null
                      ? formatCurrency(itemQuery.data.standardCostBase, baseCurrency)
                      : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Average Cost</div>
                  <div className="text-[11px] text-slate-500">Inventory valuation</div>
                  <div className="font-mono font-semibold text-slate-900">
                    {itemQuery.data.averageCost != null
                      ? formatCurrency(itemQuery.data.averageCost, baseCurrency)
                      : 'N/A'}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-600">Cost Info</div>
                  <div className="text-xs text-slate-600">
                    {itemQuery.data.averageCost != null ? 'Auto-calculated on receipts' : 'Set standard cost first'}
                  </div>
                </div>
              </div>
            </div>
            <div className="grid gap-3 text-right text-sm text-slate-700">
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowEdit((v) => !v)}
                >
                  {showEdit ? 'Close edit' : 'Edit item'}
                </Button>
              </div>
              <div>Created: {itemQuery.data.createdAt ? formatDate(itemQuery.data.createdAt) : '—'}</div>
              <div>Updated: {itemQuery.data.updatedAt ? formatDate(itemQuery.data.updatedAt) : '—'}</div>
            </div>
          </div>
        </Card>
      )}

      {itemQuery.data && (
        <Section title="Operational status">
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">{operationalStatusTitle}</div>
                <div className="mt-2 space-y-1 text-sm text-slate-700">
                  {isUsable ? (
                    <div>
                      • {formatNumber(storageTotals.available)} {defaultUom ?? '—'} usable in Storage / Available
                    </div>
                  ) : (
                    <>
                      {receivingTotals.available > 0 && (
                        <div>• Inventory exists only in Receiving &amp; Staging</div>
                      )}
                      {wipTotals.available > 0 && <div>• Inventory exists only in Production / WIP</div>}
                      {externalTotals.available > 0 && <div>• Inventory exists only in External / Virtual locations</div>}
                      {storageTotals.available <= 0 && receivingTotals.available <= 0 && wipTotals.available <= 0 && externalTotals.available <= 0 && (
                        <div>• No usable inventory on hand</div>
                      )}
                    </>
                  )}
                  {totalHolds > 0 && (
                    <div>• QC holds present ({formatNumber(totalHolds)} {defaultUom ?? '—'})</div>
                  )}
                  {totalReserved > 0 && (
                    <div>• Reserved ({formatNumber(totalReserved)} {defaultUom ?? '—'})</div>
                  )}
                  {hasNegativeAny && (
                    <div>
                      • Negative balance detected{' '}
                      <span
                        className="text-xs text-slate-500 underline"
                        title="Negative inventory means inventory was consumed or shipped before it was received or adjusted."
                      >
                        Why?
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <div className="text-xs text-slate-500">
                Default UOM: {defaultUom ?? 'Not set'}
              </div>
            </div>
          </Card>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span className={`rounded-full px-2 py-1 ${totalHolds > 0 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-700'}`}>
              {totalHolds > 0 ? '⚠ QC holds' : '✅ No holds'}
            </span>
            <span className={`rounded-full px-2 py-1 ${hasNegativeAny ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-700'}`}>
              {hasNegativeAny ? '⚠ Negative balance' : '✅ No negative balance'}
            </span>
            {metricsQuery.data?.lastCountAt && (
              <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-600">
                ℹ Last count {formatDate(metricsQuery.data.lastCountAt)}
              </span>
            )}
          </div>
        </Section>
      )}

      {itemQuery.data && (
        <Card>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Operational Metrics</div>
              <div className="text-sm text-slate-600">
                Based on the last 90 days of activity and the most recent cycle count.
              </div>
            </div>
            <div className="text-xs text-slate-500">
              Window: {metricsQuery.data?.windowDays ?? 90} days
            </div>
          </div>
          {metricsQuery.isLoading && <LoadingSpinner label="Loading metrics..." />}
          {metricsQuery.isError && (
            <Alert
              variant="error"
              title="Metrics unavailable"
              message={(metricsQuery.error as ApiError)?.message ?? 'Failed to load metrics.'}
            />
          )}
          {metricsQuery.data && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm text-slate-700">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Fill Rate</div>
                <div className="font-semibold text-slate-900">
                  {metricsQuery.data.fillRate != null
                    ? `${(metricsQuery.data.fillRate * 100).toFixed(1)}%`
                    : '—'}
                </div>
                <div className="text-xs text-slate-500">
                  {metricsQuery.data.orderedQty > 0
                    ? `${formatNumber(metricsQuery.data.shippedQty)} shipped / ${formatNumber(
                        metricsQuery.data.orderedQty,
                      )} ordered`
                    : 'No shipped order lines'}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Stockout Rate</div>
                <div className="font-semibold text-slate-900">
                  {metricsQuery.data.stockoutRate != null
                    ? `${(metricsQuery.data.stockoutRate * 100).toFixed(1)}%`
                    : '—'}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Turns</div>
                <div className="font-semibold text-slate-900">
                  {metricsQuery.data.turns != null ? metricsQuery.data.turns.toFixed(2) : '—'}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">DOI</div>
                <div className="font-semibold text-slate-900">
                  {metricsQuery.data.doiDays != null ? `${metricsQuery.data.doiDays.toFixed(1)} days` : '—'}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Last Count</div>
                <div className="font-semibold text-slate-900">
                  {metricsQuery.data.lastCountAt ? formatDate(metricsQuery.data.lastCountAt) : '—'}
                </div>
                <div className="text-xs text-slate-500">
                  {metricsQuery.data.lastCountVarianceQty != null
                    ? `Variance ${formatNumber(metricsQuery.data.lastCountVarianceQty)}`
                    : 'No variance recorded'}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Count Variance %</div>
                <div className="font-semibold text-slate-900">
                  {metricsQuery.data.lastCountVariancePct != null
                    ? `${(metricsQuery.data.lastCountVariancePct * 100).toFixed(1)}%`
                    : '—'}
                </div>
              </div>
            </div>
          )}
        </Card>
      )}
      {itemQuery.data && showEdit && (
        <div ref={editFormRef}>
          <Section title="Edit item">
            <ItemForm
              initialItem={itemQuery.data}
              onSuccess={() => {
                setShowEdit(false)
                void itemQuery.refetch()
              }}
            />
          </Section>
        </div>
      )}

      <Section
        title="Stock (authoritative)"
        description="This is the definitive view of on-hand and availability for this item. Use the location scope to narrow."
      >
        <div className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-slate-700">
            Stock is a property of an item at a location. This view aggregates the movement ledger.
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs uppercase tracking-wide text-slate-500">Location</label>
            <select
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={selectedLocationId}
              onChange={(e) => updateLocationScope(e.target.value)}
            >
              <option value="">All locations</option>
              {locationsQuery.data?.data.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.code || loc.name || 'Location'}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowRawUnits((prev) => !prev)}
            >
              {showRawUnits ? 'Hide raw units' : 'Show raw units'}
            </Button>
            {id && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  navigate(
                    `/movements?itemId=${id}${
                      selectedLocationId ? `&locationId=${selectedLocationId}` : ''
                    }`,
                  )
                }
              >
                View movements
              </Button>
            )}
          </div>
        </div>
        {locationsQuery.isLoading && <LoadingSpinner label="Loading locations..." />}
        {locationsQuery.isError && (
          <Alert
            variant="error"
            title="Locations unavailable"
            message={(locationsQuery.error as ApiError)?.message ?? 'Could not load locations.'}
            action={
              <Button size="sm" variant="secondary" onClick={() => void locationsQuery.refetch()}>
                Retry
              </Button>
            }
          />
        )}
        {snapshotQuery.isLoading && <LoadingSpinner label="Loading stock..." />}
        {snapshotQuery.isError && (
          <ErrorState error={snapshotQuery.error as ApiError} onRetry={() => void snapshotQuery.refetch()} />
        )}
        {!snapshotQuery.isLoading && !snapshotQuery.isError && (
          <>
            <div className="mb-3 text-xs uppercase tracking-wide text-slate-500">
              Scope: {selectedLocationLabel}
            </div>
            {!defaultUom && (
              <Alert
                variant="warning"
                title="Default UOM missing"
                message="Set a default UOM to view canonical inventory totals."
              />
            )}
            {hasConversionIssues && (
              <Alert
                variant="warning"
                title="Missing UOM conversions"
                message={`Add conversions to show canonical totals: ${Array.from(conversionMissingUoms).join(', ')} → ${defaultUom}.`}
              />
            )}
            {(hasNegativeBalance || hasNegativeRaw) && (
              <Alert
                variant="warning"
                title="Negative inventory detected"
                message="Negative balances indicate an out-of-order or missing transaction. Review movements to resolve."
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      if (id) navigate(`/movements?itemId=${id}`)
                    }}
                  >
                    View movements
                  </Button>
                }
              />
            )}
            {(!defaultUom || hasConversionIssues) && (
              <div className="mb-3 text-xs text-slate-500">
                Enable “Raw units” to inspect legacy or unconverted quantities.
              </div>
            )}
            {stockRows.length === 0 && (
              <EmptyState
                title="No stock activity yet"
                description="No on-hand, reservations, or incoming found for this item in the selected scope."
              />
            )}
            {stockRows.length > 0 && (
              <>
                {totalsByDefaultUom && (
                  <div className="mb-4 grid gap-3 md:grid-cols-3">
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <div className="text-xs uppercase tracking-wide text-slate-500">
                        Total available (usable) ({defaultUom})
                      </div>
                      <div className="mt-1 text-2xl font-semibold text-slate-900">
                        {formatNumber(totalsByDefaultUom.available)}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        On hand {formatNumber(totalsByDefaultUom.onHand)} ·{' '}
                        <span className="inline-flex items-center gap-1">
                          Reserved {formatNumber(totalsByDefaultUom.reserved)}
                          <button
                            type="button"
                            className="text-brand-700 underline"
                            title="Reserved stock is allocated to orders and not available."
                          >
                            Explain
                          </button>
                        </span>{' '}
                        ·{' '}
                        <span className="inline-flex items-center gap-1">
                          Held {formatNumber(totalsByDefaultUom.held)}
                          <button
                            type="button"
                            className="text-brand-700 underline"
                            title="Held stock is quarantined or awaiting QC and not usable."
                          >
                            Explain
                          </button>
                        </span>{' '}
                        ·{' '}
                        <span className="inline-flex items-center gap-1">
                          Rejected {formatNumber(totalsByDefaultUom.rejected)}
                          <button
                            type="button"
                            className="text-brand-700 underline"
                            title="Rejected stock is non-usable and should not be put away."
                          >
                            Explain
                          </button>
                        </span>
                      </div>
                    </div>
                  </div>
                )}
                <div className="text-xs uppercase tracking-wide text-slate-500">
                  Location breakdown by lifecycle
                </div>
                <div className="mt-2 space-y-4">
                  {stageOrder.map((stage) => {
                    const rows = groupedRows.get(stage) ?? []
                    if (rows.length === 0) return null
                    const helper =
                      stage === 'Receiving & Staging'
                        ? 'Inventory here may not be consumable.'
                        : stage === 'Production / WIP'
                          ? 'Inventory here is in-process and not usable.'
                          : stage === 'Quarantine / Rejected'
                            ? 'Inventory here is on hold or rejected.'
                            : stage === 'External / Virtual'
                              ? 'Inventory here is not available for use.'
                              : 'Inventory here is available for use.'
                    return (
                      <div key={stage} className="space-y-2">
                        <div className="text-sm font-semibold text-slate-700">{stage}</div>
                        <div className="text-xs text-slate-500">{helper}</div>
                        <InventorySnapshotTable
                          rows={rows}
                          showItem={false}
                          showLocation={!selectedLocationId}
                          locationLookup={locationLookup}
                        />
                      </div>
                    )
                  })}
                </div>
                {showRawUnits && (
                  <div className="mt-6 space-y-2">
                    <div className="text-xs uppercase tracking-wide text-slate-500">
                      Raw units (legacy + entered UOMs)
                    </div>
                    <InventorySnapshotTable
                      rows={stockRows}
                      showItem={false}
                      showLocation={!selectedLocationId}
                      locationLookup={locationLookup}
                    />
                  </div>
                )}
              </>
            )}
          </>
        )}
        <div className="pt-3 text-xs text-slate-500">
          Stock is derived from the movement ledger (append-only).
        </div>
      </Section>

      <Section title="BOMs">
        {bomsQuery.isLoading && <LoadingSpinner label="Loading BOMs..." />}
        {bomsQuery.isError && bomsQuery.error && (
          <ErrorState error={bomsQuery.error as unknown as ApiError} onRetry={() => void bomsQuery.refetch()} />
        )}
        <div className="flex flex-wrap items-start justify-between gap-3 pb-2">
          <div className="text-sm text-slate-700">
            BOMs are versioned recipes. Activate exactly one version to use in work orders.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setShowBomForm((v) => !v)
                if (!showBomForm) setBomMessage(null)
              }}
            >
              {showBomForm ? 'Close panel' : 'New BOM version'}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                if (!bomSummary.activeBom || !id) return
                navigate(`/work-orders/new?outputItemId=${id}&bomId=${bomSummary.activeBom.id}`)
              }}
              disabled={!bomSummary.activeBom || !id}
            >
              Create work order
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600 pb-3">
          <span>
            Active BOM:{' '}
            {bomSummary.activeBom && bomSummary.activeVersion
              ? `${bomSummary.activeBom.bomCode} (v${bomSummary.activeVersion.versionNumber})`
              : 'No active BOM'}
          </span>
          <span>Versions: {bomSummary.versionCount}</span>
          {!bomSummary.activeBom && (
            <span className="text-xs text-slate-500">Activate a version to create work orders.</span>
          )}
        </div>
        {bomMessage && <Alert variant="success" title="BOM updated" message={bomMessage} className="mb-3" />}
        {showBomForm && itemQuery.data && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <BomForm
              outputItemId={itemQuery.data.id}
              defaultUom={itemQuery.data.defaultUom || undefined}
              onSuccess={() => {
                setShowBomForm(false)
                setBomMessage('BOM created.')
                void bomsQuery.refetch()
              }}
            />
          </div>
        )}
        {!bomsQuery.isLoading && !bomsQuery.isError && bomsQuery.data?.boms.length === 0 && (
          <EmptyState
            title={
              itemQuery.data?.type === 'wip' || itemQuery.data?.type === 'finished'
                ? 'BOM required for production'
                : 'No BOM required'
            }
            description={
              itemQuery.data?.type === 'wip' || itemQuery.data?.type === 'finished'
                ? 'This item cannot be produced or disassembled without a BOM.'
                : 'Raw and packaging items can be received without a BOM.'
            }
            action={
              itemQuery.data?.type === 'wip' || itemQuery.data?.type === 'finished' ? (
                <Button size="sm" onClick={() => setShowBomForm(true)}>
                  Create BOM
                </Button>
              ) : undefined
            }
          />
        )}
        <div className="grid gap-4">
          {bomsQuery.data?.boms.map((bom) => (
            <BomCard
              key={bom.id}
              bomId={bom.id}
              fallback={bom}
              onChanged={() => void bomsQuery.refetch()}
              onDuplicate={(sourceBom, sourceVersion) => openBomModal({ bom: sourceBom, version: sourceVersion })}
            />
          ))}
        </div>
      </Section>

      {itemQuery.data && (
        <Section title="UoM Conversions">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <UomConversionsCard item={itemQuery.data} conversions={uomConversionsQuery.data ?? []} />
          </div>
        </Section>
      )}

      {itemQuery.data && (
        <Section title="Production Routings">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <RoutingsCard itemId={itemQuery.data.id} />
          </div>
        </Section>
      )}

      <Modal
        isOpen={showBomModal}
        onClose={closeBomModal}
        title={bomDraftSource ? 'New BOM version' : 'Create BOM'}
        className="max-h-[92vh] w-full max-w-[90vw] overflow-hidden"
      >
        <div className="max-h-[80vh] overflow-y-auto pr-4">
          {itemQuery.data && (
            <BomForm
              outputItemId={itemQuery.data.id}
              defaultUom={itemQuery.data.defaultUom || undefined}
              initialBom={bomDraftSource ?? undefined}
              onSuccess={() => {
                closeBomModal()
                setBomMessage('BOM created.')
                void bomsQuery.refetch()
              }}
            />
          )}
        </div>
      </Modal>
    </div>
  )
}
