import type { InventorySnapshotRow, ReplenishmentRecommendation } from '@api/types'
import { Link } from 'react-router-dom'
import { Alert, Badge, Button, Card, LoadingSpinner, Section } from '@shared/ui'
import { formatNumber } from '@shared/formatters'

type AttentionTile = {
  key: string
  title: string
  count: string
  helper: string
  signal: { label: string; variant: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }
  cta: { label: string; to: string }
  scrollTarget?: boolean
}

type Props = {
  tiles: AttentionTile[]
  exceptionLoading: boolean
  exceptionError: boolean
  reorderNeeded: ReplenishmentRecommendation[]
  availabilityIssues: InventorySnapshotRow[]
  formatItem: (id: string) => string
  formatLocation: (id: string) => string
  onRetry: () => void
  attentionListId?: string
}

export function AttentionRequiredSection({
  tiles,
  exceptionLoading,
  exceptionError,
  reorderNeeded,
  availabilityIssues,
  formatItem,
  formatLocation,
  onRetry,
  attentionListId = 'attention-list',
}: Props) {
  const scrollToAttentionList = () => {
    const target = document.getElementById(attentionListId)
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <Section title="Attention required" description="Critical items that need action now.">
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {tiles.map((tile) => (
            <Card key={tile.key} className="h-full">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">{tile.title}</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-900">{tile.count}</p>
                  <p className="mt-1 text-xs text-slate-500">{tile.helper}</p>
                </div>
                <Badge variant={tile.signal.variant}>{tile.signal.label}</Badge>
              </div>
              <div className="mt-3">
                {tile.scrollTarget ? (
                  <Button size="sm" variant="secondary" onClick={scrollToAttentionList}>
                    {tile.cta.label}
                  </Button>
                ) : (
                  <Link to={tile.cta.to}>
                    <Button size="sm" variant="secondary">
                      {tile.cta.label}
                    </Button>
                  </Link>
                )}
              </div>
            </Card>
          ))}
        </div>

        <Card title="Resolution queue" description="Resolve exceptions and commitments before moving on.">
          {exceptionLoading && <LoadingSpinner label="Scanning for exceptions..." />}
          {exceptionError && (
            <Alert
              variant="error"
              title="Could not load exceptions"
              message="Retry to refresh recommendations and inventory coverage."
              action={
                <Button size="sm" variant="secondary" onClick={onRetry}>
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
              <div id={attentionListId} className="divide-y divide-slate-200">
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
  )
}
