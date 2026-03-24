import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { Bom, BomVersion } from '../../../api/types'
import { Modal } from '../../../components/Modal'
import { ErrorState, LoadingSpinner } from '../../../shared/ui'
import { EntityPageLayout } from '../../../shared/ui/EntityPageLayout'
import { BomForm } from '../../boms/components/BomForm'
import { ItemConfigurationSection } from '../components/ItemConfigurationSection'
import { ItemContextRail } from '../components/ItemContextRail'
import { ItemHeader } from '../components/ItemHeader'
import { ItemHealthBanner } from '../components/ItemHealthBanner'
import { ItemHistorySection } from '../components/ItemHistorySection'
import { ItemInventorySection } from '../components/ItemInventorySection'
import { ItemProductionSection } from '../components/ItemProductionSection'
import { ItemSectionNav } from '../components/ItemSectionNav'
import { MetricGrid } from '../components/MetricGrid'
import { MetricTile } from '../components/MetricTile'
import { useItemDetailPageModel, itemDetailSectionLinks } from '../hooks/useItemDetailPageModel'
import { useAuth } from '@shared/auth'

export default function ItemDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const baseCurrency = user?.baseCurrency ?? 'THB'
  const [searchParams, setSearchParams] = useSearchParams()
  const [showEdit, setShowEdit] = useState(false)
  const [showBomForm, setShowBomForm] = useState(false)
  const [showBomModal, setShowBomModal] = useState(false)
  const [bomDraftSource, setBomDraftSource] = useState<{ bom?: Bom; version?: BomVersion } | null>(null)
  const [bomMessage, setBomMessage] = useState<string | null>(null)
  const [idCopied, setIdCopied] = useState(false)
  const editFormRef = useRef<HTMLDivElement | null>(null)
  const copyTimeoutRef = useRef<number | null>(null)
  const selectedLocationId = searchParams.get('locationId') ?? ''
  const model = useItemDetailPageModel({ id, selectedLocationId })

  useEffect(() => {
    if (model.itemQuery.isError && model.itemQuery.error?.status === 404) {
      navigate('/not-found', { replace: true })
    }
  }, [model.itemQuery.error, model.itemQuery.isError, navigate])

  useEffect(() => {
    if (!showEdit) return
    editFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    editFormRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')?.focus()
  }, [showEdit])

  useEffect(() => () => {
    if (copyTimeoutRef.current != null) window.clearTimeout(copyTimeoutRef.current)
  }, [])

  const copyId = async () => {
    if (!id) return
    try {
      await navigator.clipboard.writeText(id)
      setIdCopied(true)
      if (copyTimeoutRef.current != null) window.clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = window.setTimeout(() => setIdCopied(false), 1800)
    } catch {
      // ignore clipboard failures
    }
  }

  const updateLocationScope = (nextLocationId: string) => {
    const nextParams = new URLSearchParams(searchParams)
    nextLocationId ? nextParams.set('locationId', nextLocationId) : nextParams.delete('locationId')
    setSearchParams(nextParams)
  }

  if (model.itemQuery.isLoading) return <LoadingSpinner label="Loading item..." />
  if (model.itemQuery.isError && model.itemQuery.error) {
    return <ErrorState error={model.itemQuery.error} onRetry={() => void model.itemQuery.refetch()} />
  }
  if (!model.item) return null

  return (
    <>
      <EntityPageLayout
        header={
          <section id="overview" className="space-y-6">
            <ItemHeader
              item={model.item}
              onBack={() => navigate('/items')}
              onEdit={() => setShowEdit((value) => !value)}
              onAdjustStock={() => id && navigate(`/inventory-adjustments/new?itemId=${id}`)}
              onCreateReplenishmentPolicy={() => id && navigate(`/replenishment-policies/new?itemId=${id}&source=item`)}
              onCopyId={copyId}
              idCopied={idCopied}
            />
          </section>
        }
        health={
          <ItemHealthBanner
            health={model.health}
            diagnostics={model.diagnostics}
            onAction={(actionId) => {
              if (actionId === 'fix_conversions') document.getElementById('configuration')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              if (actionId === 'adjust_stock' && id) navigate(`/inventory-adjustments/new?itemId=${id}`)
              if (actionId === 'create_bom') { setShowBomForm(true); document.getElementById('production')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
              if (actionId === 'create_routing') document.getElementById('production')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              if (actionId === 'view_movements') navigate(model.movementLink)
              if (actionId === 'edit_item') setShowEdit(true)
            }}
          />
        }
        metrics={
          <MetricGrid>
            {model.metricTiles.map((tile) => (
              <MetricTile key={tile.label} label={tile.label} value={tile.value} subtext={tile.subtext} status={tile.status} />
            ))}
          </MetricGrid>
        }
        sectionNav={<ItemSectionNav sections={itemDetailSectionLinks} />}
        contextRail={
          <ItemContextRail
            item={model.item}
            baseCurrency={baseCurrency}
            bomSummary={model.bomSummary}
            conversionState={model.conversionState}
            hasManufacturingFlow={model.hasManufacturingFlow}
            missingConversionUnits={model.healthConfiguration.missingConversionUnits}
            routingCount={model.routingsQuery.data?.length ?? 0}
          />
        }
      >
        <ItemInventorySection
          lifecycleStages={model.lifecycleStages}
          canonicalUom={model.conversionState.canonicalUom}
          selectedLocationId={selectedLocationId}
          selectedLocationLabel={model.selectedLocationLabel}
          locations={model.locationsQuery.data?.data ?? []}
          locationLookup={model.locationLookup}
          stockRows={model.stockRows}
          factorByUom={model.conversionState.factorByUom}
          missingConversionUnits={model.healthConfiguration.missingConversionUnits}
          hasNegativeOnHand={model.inventorySummary.hasNegativeOnHand}
          isLoading={model.inventoryQuery.isLoading}
          error={model.inventoryQuery.error}
          onRetry={() => void model.inventoryQuery.refetch()}
          onLocationChange={updateLocationScope}
          onViewMovements={() => navigate(model.movementLink)}
          onAdjustStock={() => id && navigate(`/inventory-adjustments/new?itemId=${id}`)}
        />
        <ItemProductionSection
          item={model.item}
          itemId={model.item.id}
          summary={model.bomSummary}
          boms={model.bomsQuery.data?.boms ?? []}
          isLoading={model.bomsQuery.isLoading}
          error={model.bomsQuery.error ?? null}
          showComposer={showBomForm}
          message={bomMessage}
          onToggleComposer={() => { setShowBomForm((value) => !value); if (!showBomForm) setBomMessage(null) }}
          onCreateWorkOrder={() => model.bomSummary.activeBom && id && navigate(`/work-orders/new?outputItemId=${id}&bomId=${model.bomSummary.activeBom.id}`)}
          onCreated={() => { setShowBomForm(false); setBomMessage('BOM created.'); void model.bomsQuery.refetch() }}
          onRefetch={() => void model.bomsQuery.refetch()}
          onDuplicate={(payload) => { setBomDraftSource(payload); setShowBomModal(true) }}
        />
        <ItemConfigurationSection
          item={model.item}
          conversionState={model.conversionState}
          manualConversions={model.uomConversionsQuery.data ?? []}
          showEdit={showEdit}
          editFormRef={editFormRef}
          onSaved={() => { setShowEdit(false); void model.itemQuery.refetch() }}
        />
        <ItemHistorySection item={model.item} baseCurrency={baseCurrency} onViewLedger={() => navigate(model.movementLink)} />
      </EntityPageLayout>
      <Modal
        isOpen={showBomModal}
        onClose={() => { setShowBomModal(false); setBomDraftSource(null) }}
        title={bomDraftSource ? 'New BOM version' : 'Create BOM'}
        className="max-h-[92vh] w-full max-w-[90vw] overflow-hidden"
      >
        <div className="max-h-[80vh] overflow-y-auto pr-4">
          <BomForm
            outputItemId={model.item.id}
            defaultUom={model.item.defaultUom || undefined}
            initialBom={bomDraftSource ?? undefined}
            onSuccess={() => { setShowBomModal(false); setBomDraftSource(null); setBomMessage('BOM created.'); void model.bomsQuery.refetch() }}
          />
        </div>
      </Modal>
    </>
  )
}
