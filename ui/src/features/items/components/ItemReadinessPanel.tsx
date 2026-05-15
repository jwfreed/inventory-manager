import { CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { formatNumber } from '@shared/formatters'
import { Button } from '../../../components/Button'
import { cn } from '../../../lib/utils'

type Props = {
  available: number
  onHand: number
  reserved: number
  inTransit: number
  backordered: number
  canonicalUom: string | null
  hasNegativeOnHand: boolean
  hasManufacturingFlow: boolean
  hasActiveBom: boolean
  hasRouting: boolean
  onAdjustStock: () => void
  onViewMovements: () => void
  onCreateRouting: () => void
}

export function ItemReadinessPanel({
  available,
  onHand,
  reserved,
  inTransit,
  backordered,
  canonicalUom,
  hasNegativeOnHand,
  hasManufacturingFlow,
  hasActiveBom,
  hasRouting,
  onAdjustStock,
  onViewMovements,
  onCreateRouting,
}: Props) {
  const hasStock = available > 0
  const uomLabel = canonicalUom ?? 'units'

  const inventoryBorderClass = hasNegativeOnHand
    ? 'border-rose-200 bg-rose-50/50'
    : hasStock
      ? 'border-green-200 bg-green-50/50'
      : 'border-amber-200 bg-amber-50/50'

  const mfgBorderClass =
    !hasManufacturingFlow || (hasActiveBom && hasRouting)
      ? 'border-green-200 bg-green-50/50'
      : 'border-amber-200 bg-amber-50/50'

  const inventorySummaryParts = [
    `${formatNumber(onHand)} ${uomLabel} on hand`,
    `${formatNumber(reserved)} reserved`,
    `${formatNumber(inTransit)} in transit`,
  ]
  if (backordered > 0) {
    inventorySummaryParts.push(`${formatNumber(backordered)} backordered`)
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {/* Inventory readiness */}
      <div
        className={cn(
          'rounded-2xl border px-5 py-5 shadow-sm shadow-slate-950/5',
          inventoryBorderClass,
        )}
      >
        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
          Inventory
        </div>
        {hasStock ? (
          <div className="text-base font-semibold text-slate-950">
            {formatNumber(available)} {uomLabel} available
          </div>
        ) : (
          <div className="text-base font-semibold text-slate-950">
            No finished goods available
          </div>
        )}
        <div className="mt-1 text-sm text-slate-600">{inventorySummaryParts.join(' · ')}</div>
        {hasNegativeOnHand && (
          <div className="mt-1 text-xs font-medium text-rose-700">
            Negative on-hand detected — check the movement ledger.
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={onAdjustStock}>
            Adjust stock
          </Button>
          <Button variant="secondary" size="sm" onClick={onViewMovements}>
            View movements
          </Button>
        </div>
      </div>

      {/* Manufacturing readiness */}
      {hasManufacturingFlow ? (
        <div
          className={cn(
            'rounded-2xl border px-5 py-5 shadow-sm shadow-slate-950/5',
            mfgBorderClass,
          )}
        >
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            Manufacturing
          </div>
          {!hasActiveBom ? (
            <>
              <div className="text-base font-semibold text-slate-950">Setup incomplete</div>
              <div className="mt-1 text-sm text-slate-600">No active BOM configured.</div>
            </>
          ) : !hasRouting ? (
            <>
              <div className="text-base font-semibold text-amber-800">Setup incomplete</div>
              <div className="mt-2 flex flex-col gap-1.5 text-sm">
                <div className="flex items-center gap-1.5 text-green-700">
                  <CheckCircleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  BOM configured
                </div>
                <div className="flex items-center gap-1.5 text-amber-700">
                  <ExclamationTriangleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  Routing missing
                </div>
              </div>
              <div className="mt-3">
                <Button size="sm" onClick={onCreateRouting}>
                  Create routing
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="text-base font-semibold text-slate-950">Ready</div>
              <div className="mt-2 flex flex-col gap-1.5 text-sm">
                <div className="flex items-center gap-1.5 text-green-700">
                  <CheckCircleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  BOM configured
                </div>
                <div className="flex items-center gap-1.5 text-green-700">
                  <CheckCircleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  Routing configured
                </div>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
