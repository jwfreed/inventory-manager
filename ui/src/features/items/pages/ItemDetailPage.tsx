import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useItem } from '../queries'
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
import { formatDate, formatNumber } from '@shared/formatters'
import { ItemForm } from '../components/ItemForm'
import { BomForm } from '../../boms/components/BomForm'
import { BomCard } from '../../boms/components/BomCard'
import { InventorySnapshotTable } from '../../inventory/components/InventorySnapshotTable'
import { UomConversionsCard } from '../components/UomConversionsCard'

const typeLabels: Record<string, string> = {
  raw: 'Raw',
  wip: 'WIP',
  finished: 'Finished',
  packaging: 'Packaging',
}

export default function ItemDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [showEdit, setShowEdit] = useState(false)
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
  const locationLookup = useMemo(() => {
    const map = new Map<string, { code?: string; name?: string }>()
    locationsQuery.data?.data?.forEach((loc) => {
      map.set(loc.id, { code: loc.code, name: loc.name })
    })
    return map
  }, [locationsQuery.data])
  const totalsByUom = useMemo(() => {
    const map = new Map<string, { onHand: number; available: number; reserved: number; held: number; rejected: number }>()
    stockRows.forEach((row) => {
      const current = map.get(row.uom) ?? { onHand: 0, available: 0, reserved: 0, held: 0, rejected: 0 }
      current.onHand += row.onHand
      current.available += row.available
      current.reserved += row.reserved
      current.held += row.held
      current.rejected += row.rejected
      map.set(row.uom, current)
    })
    return Array.from(map.entries()).map(([uom, totals]) => ({ uom, ...totals }))
  }, [stockRows])
  const selectedLocationLabel = useMemo(() => {
    if (!selectedLocationId) return 'All locations'
    const loc = locationsQuery.data?.data.find((row) => row.id === selectedLocationId)
    if (!loc) return selectedLocationId
    const code = loc.code ?? loc.id
    return loc.name ? `${code} — ${loc.name}` : code
  }, [locationsQuery.data, selectedLocationId])

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
            variant="secondary"
            size="sm"
            onClick={() => {
              if (id) navigate(`/inventory-adjustments/new?itemId=${id}`)
            }}
          >
            Adjust stock
          </Button>
          <Button variant="secondary" size="sm" onClick={copyId}>
            Copy ID
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
                  {loc.code || loc.name || loc.id}
                </option>
              ))}
            </select>
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
            {stockRows.length === 0 && (
              <EmptyState
                title="No stock activity yet"
                description="No on-hand, reservations, or incoming found for this item in the selected scope."
              />
            )}
            {stockRows.length > 0 && (
              <>
                <div className="mb-4 grid gap-3 md:grid-cols-3">
                  {totalsByUom.map((totals) => (
                    <div key={totals.uom} className="rounded-lg border border-slate-200 bg-white p-3">
                      <div className="text-xs uppercase tracking-wide text-slate-500">
                        Total available (usable) ({totals.uom})
                      </div>
                      <div className="mt-1 text-2xl font-semibold text-slate-900">
                        {formatNumber(totals.available)}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        On hand {formatNumber(totals.onHand)} ·{' '}
                        <span className="inline-flex items-center gap-1">
                          Reserved {formatNumber(totals.reserved)}
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
                          Held {formatNumber(totals.held)}
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
                          Rejected {formatNumber(totals.rejected)}
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
                  ))}
                </div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Location breakdown</div>
                <div className="mt-2">
                  <InventorySnapshotTable
                    rows={stockRows}
                    showItem={false}
                    showLocation={!selectedLocationId}
                    locationLookup={locationLookup}
                  />
                </div>
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
            title="No BOMs yet"
            description="Create a BOM to define components for this item."
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

      <Section title="UoM Conversions">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <UomConversionsCard item={itemQuery.data} conversions={uomConversionsQuery.data ?? []} />
        </div>
      </Section>

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
