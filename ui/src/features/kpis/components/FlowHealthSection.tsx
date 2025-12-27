import type { ReactNode } from 'react'
import type { ApiError, InventorySnapshotRow } from '../../../api/types'
import { Link } from 'react-router-dom'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { DataTable } from '../../../shared'

type ProductionRow = {
  itemId: string
  uom: string
  planned: number
  completed: number
  remaining: number
}

type Props = {
  productionRows: ProductionRow[]
  productionLoading: boolean
  productionError: boolean
  productionErrorObj?: ApiError | null
  onProductionRetry: () => void
  availabilityIssues: InventorySnapshotRow[]
  inventoryLoading: boolean
  inventoryError: boolean
  inventoryErrorObj?: ApiError | null
  onInventoryRetry: () => void
  formatItem: (id: string) => string
  formatLocation: (id: string) => string
  fillRateCard: ReactNode
}

export function FlowHealthSection({
  productionRows,
  productionLoading,
  productionError,
  productionErrorObj,
  onProductionRetry,
  availabilityIssues,
  inventoryLoading,
  inventoryError,
  inventoryErrorObj,
  onInventoryRetry,
  formatItem,
  formatLocation,
  fillRateCard,
}: Props) {
  return (
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
          {productionLoading && <LoadingSpinner label="Loading production summary..." />}
          {productionError && productionErrorObj && (
            <ErrorState error={productionErrorObj} onRetry={onProductionRetry} />
          )}
          {!productionLoading && !productionError && productionRows.length === 0 && (
            <EmptyState
              title="No open work orders"
              description="When work orders have remaining quantities, they will appear here."
            />
          )}
          {!productionLoading && !productionError && productionRows.length > 0 && (
            <DataTable
              rows={productionRows}
              rowKey={(row) => `${row.itemId}-${row.uom}`}
              columns={[
                {
                  id: 'item',
                  header: 'Item to make',
                  cell: (row) => (
                    <Link
                      to={`/work-orders?itemId=${encodeURIComponent(row.itemId)}`}
                      className="text-brand-700 hover:underline"
                    >
                      {formatItem(row.itemId)}
                    </Link>
                  ),
                },
                {
                  id: 'planned',
                  header: 'Planned qty',
                  align: 'right',
                  cell: (row) => `${row.planned} ${row.uom}`,
                },
                {
                  id: 'completed',
                  header: 'Completed',
                  align: 'right',
                  cell: (row) => `${row.completed} ${row.uom}`,
                },
                {
                  id: 'remaining',
                  header: 'Remaining',
                  align: 'right',
                  cell: (row) => `${row.remaining} ${row.uom}`,
                },
              ]}
            />
          )}
        </Card>

        <Card
          title="Availability hot spots"
          description="Exceptions only. Open Item → Stock for authoritative totals."
          action={
            <Link to="/items">
              <Button size="sm" variant="secondary">
                Browse items
              </Button>
            </Link>
          }
        >
          {inventoryLoading && <LoadingSpinner label="Loading inventory..." />}
          {inventoryError && inventoryErrorObj && (
            <ErrorState error={inventoryErrorObj} onRetry={onInventoryRetry} />
          )}
          {!inventoryLoading && !inventoryError && availabilityIssues.length === 0 && (
            <EmptyState
              title="No availability risks"
              description="No low/negative availability detected in the current snapshot."
            />
          )}
          {!inventoryLoading && !inventoryError && availabilityIssues.length > 0 && (
            <div className="divide-y divide-slate-200">
              {availabilityIssues.slice(0, 5).map((row) => {
                const availabilitySeverity = row.available < 0 || row.inventoryPosition < 0
                const availabilityLabel = availabilitySeverity ? 'Action required' : 'Watch'
                const availabilityVariant = availabilitySeverity ? 'danger' : 'warning'
                const itemLink = `/items/${row.itemId}?locationId=${encodeURIComponent(row.locationId)}`
                return (
                  <div key={`hotspot-${row.itemId}-${row.locationId}-${row.uom}`} className="py-3">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <Badge variant={availabilityVariant}>{availabilityLabel}</Badge>
                          <span className="text-xs font-semibold uppercase text-slate-500">Availability</span>
                        </div>
                        <p className="text-sm font-semibold text-slate-900">
                          Risk at {formatItem(row.itemId)} @ {formatLocation(row.locationId)}
                        </p>
                        <p className="text-xs text-slate-500">
                          Open Item → Stock to see definitive on-hand and availability.
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <Link to={itemLink}>
                          <Button size="sm" variant="secondary">
                            Open stock
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
  )
}
