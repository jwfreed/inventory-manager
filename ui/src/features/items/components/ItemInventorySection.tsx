import { formatNumber } from '@shared/formatters'
import { useMemo } from 'react'
import type { ApiError, InventorySnapshotRow, Location } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { DataTable, EmptyState, Panel } from '../../../shared/ui'
import type { InventoryLifecycleStage } from '../itemDetail.models'
import { normalizeUomCode } from '../itemDetail.logic'
import { InventoryLifecycle } from './InventoryLifecycle'

const inventoryStageOrder = [
  'Storage / Available',
  'Receiving & Staging',
  'Production / WIP',
  'Quarantine / Rejected',
  'External / Virtual',
] as const

type LocationMeta = {
  code?: string
  name?: string
  type?: string
  role?: string
  isSellable?: boolean
}

type Props = {
  lifecycleStages: InventoryLifecycleStage[]
  canonicalUom: string | null
  selectedLocationId: string
  selectedLocationLabel: string
  locations: Location[]
  locationLookup: Map<string, LocationMeta>
  stockRows: InventorySnapshotRow[]
  factorByUom: Map<string, number>
  missingConversionUnits: string[]
  hasNegativeOnHand: boolean
  isLoading: boolean
  error?: ApiError | null
  onRetry: () => void
  onLocationChange: (locationId: string) => void
  onViewMovements: () => void
  onAdjustStock: () => void
}

function formatLocation(row: InventorySnapshotRow, locationLookup: Map<string, LocationMeta>) {
  const meta = locationLookup.get(row.locationId)
  if (!meta) return row.locationId || 'Unknown location'
  const code = meta.code ?? row.locationId
  return meta.name ? `${code} — ${meta.name}` : code
}

function classifyLocationStage(locationId: string, locationLookup: Map<string, LocationMeta>) {
  const location = locationLookup.get(locationId)
  if (!location) return 'External / Virtual'
  const type = location.type?.toLowerCase() ?? ''
  if (location.role && location.role !== 'SELLABLE') return 'Quarantine / Rejected'
  if (location.isSellable === false) return 'Quarantine / Rejected'
  if (type.includes('receiv') || type.includes('stage')) return 'Receiving & Staging'
  if (type.includes('prod') || type.includes('wip') || type.includes('manufactur')) return 'Production / WIP'
  if (
    ['warehouse', 'bin', 'store'].includes(type) ||
    type.includes('warehouse') ||
    type.includes('bin') ||
    type.includes('store')
  ) {
    return 'Storage / Available'
  }
  return 'External / Virtual'
}

export function ItemInventorySection({
  lifecycleStages,
  canonicalUom,
  selectedLocationId,
  selectedLocationLabel,
  locations,
  locationLookup,
  stockRows,
  factorByUom,
  missingConversionUnits,
  hasNegativeOnHand,
  isLoading,
  error,
  onRetry,
  onLocationChange,
  onViewMovements,
  onAdjustStock,
}: Props) {
  const stageGroups = useMemo(
    () =>
      inventoryStageOrder
        .map((stage) => {
          const rows = stockRows.filter(
            (row) => classifyLocationStage(row.locationId, locationLookup) === stage,
          )
          const available = rows.reduce((sum, row) => {
            const factor = factorByUom.get(normalizeUomCode(row.uom)) ?? 0
            return sum + row.available * factor
          }, 0)
          return { stage, rows, available }
        })
        .filter((entry) => entry.rows.length > 0),
    [factorByUom, locationLookup, stockRows],
  )

  return (
    <section id="inventory" className="space-y-4 scroll-mt-24">
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Inventory</h2>
        <p className="max-w-3xl text-sm leading-6 text-slate-600">
          Lifecycle, scope, warnings, and stage-by-stage breakdown for the authoritative stock view.
        </p>
      </div>

      <Panel
        title="Inventory lifecycle"
        description="Fixed inventory stages normalized to the canonical unit when the system registry or item overrides can resolve conversions."
      >
        <InventoryLifecycle stages={lifecycleStages} uom={canonicalUom} />
      </Panel>

      <Panel
        title="Inventory state"
        description="Inventory is grouped by operational stage and scoped by location."
        actions={
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
              onChange={(event) => onLocationChange(event.target.value)}
            >
              <option value="">All locations</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.code || location.name || 'Location'}
                </option>
              ))}
            </select>
            <Button variant="secondary" size="sm" onClick={onViewMovements}>
              View movements
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="text-sm text-slate-600">Scope: {selectedLocationLabel}</div>

          {isLoading ? <LoadingSpinner label="Loading inventory..." /> : null}
          {error ? <ErrorState error={error} onRetry={onRetry} /> : null}

          {missingConversionUnits.length > 0 ? (
            <Alert
              variant="warning"
              title="Missing UOM normalization"
              message={`Inventory cannot be fully normalized for ${missingConversionUnits.join(', ')}.`}
            />
          ) : null}

          {hasNegativeOnHand ? (
            <Alert
              variant="warning"
              title="Negative inventory detected"
              message="Movement ordering is inconsistent for at least one stock row."
              action={
                <Button variant="secondary" size="sm" onClick={onViewMovements}>
                  Investigate
                </Button>
              }
            />
          ) : null}

          {stockRows.length === 0 && !isLoading ? (
            <EmptyState
              title="No inventory"
              description="This item has no on-hand, reservation, or inbound movement in the selected scope."
              action={
                <Button variant="secondary" size="sm" onClick={onAdjustStock}>
                  Adjust stock
                </Button>
              }
            />
          ) : null}

          <div className="space-y-4">
            {stageGroups.map(({ stage, rows, available }) => (
              <div
                key={stage}
                className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/60"
              >
                <div className="border-b border-slate-200 px-5 py-4">
                  <div className="text-base font-semibold text-slate-900">{stage}</div>
                  <div className="mt-1 text-sm text-slate-600">
                    Available {formatNumber(available)} {canonicalUom ?? ''}
                  </div>
                </div>
                <div className="px-5 py-4">
                  <DataTable
                    rows={rows}
                    rowKey={(row) => `${row.itemId}-${row.locationId}-${row.uom}`}
                    columns={[
                      ...(selectedLocationId
                        ? []
                        : [
                            {
                              id: 'location',
                              header: 'Location',
                              cell: (row: InventorySnapshotRow) => formatLocation(row, locationLookup),
                            },
                          ]),
                      { id: 'uom', header: 'UOM', cell: (row: InventorySnapshotRow) => row.uom },
                      {
                        id: 'onHand',
                        header: 'On hand',
                        align: 'right' as const,
                        cell: (row: InventorySnapshotRow) => formatNumber(row.onHand),
                      },
                      {
                        id: 'reserved',
                        header: 'Reserved',
                        align: 'right' as const,
                        cell: (row: InventorySnapshotRow) => formatNumber(row.reserved),
                      },
                      {
                        id: 'available',
                        header: 'Available',
                        align: 'right' as const,
                        cell: (row: InventorySnapshotRow) => formatNumber(row.available),
                      },
                      {
                        id: 'inTransit',
                        header: 'In transit',
                        align: 'right' as const,
                        cell: (row: InventorySnapshotRow) => formatNumber(row.inTransit),
                      },
                      {
                        id: 'backordered',
                        header: 'Backordered',
                        align: 'right' as const,
                        cell: (row: InventorySnapshotRow) => formatNumber(row.backordered),
                      },
                      {
                        id: 'inventoryPosition',
                        header: 'Position',
                        align: 'right' as const,
                        cell: (row: InventorySnapshotRow) => formatNumber(row.inventoryPosition),
                      },
                    ]}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </section>
  )
}
