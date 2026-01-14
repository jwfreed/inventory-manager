import { Button, Combobox, type ComboboxOption, Input, Textarea } from '@shared/ui'
import { cn } from '../../../lib/utils'
import { formatCurrency, formatNumber } from '../../../lib/formatters'
import type { Item } from '@api/types'
import type { PurchaseOrderLineDraft, PurchaseOrderLineStats, PurchaseOrderLineValidation } from '../types'

export type ItemOption = ComboboxOption

type Props = {
  lines: PurchaseOrderLineDraft[]
  itemOptions: ItemOption[]
  itemLookup: Map<string, Item>
  itemsLoading: boolean
  lineStats: PurchaseOrderLineStats
  lineValidation: PurchaseOrderLineValidation[]
  currencyCode: string
  subtotal: number
  onAddLine: () => void
  onRemoveLine: (index: number) => void
  onUpdateLine: (index: number, patch: Partial<PurchaseOrderLineDraft>) => void
  onItemSearch: (query: string) => void
}

export function PurchaseOrderLinesSection({
  lines,
  itemOptions,
  itemLookup,
  itemsLoading,
  lineStats,
  lineValidation,
  currencyCode,
  subtotal,
  onAddLine,
  onRemoveLine,
  onUpdateLine,
  onItemSearch,
}: Props) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-800">Step 2: Line items</div>
          <p className="text-xs text-slate-500">Lines drive cost and inventory impact.</p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onAddLine}>
          Add line
        </Button>
      </div>
      <div className="mt-3 space-y-3">
        {lines.map((line, idx) => (
          <div key={idx} className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-7">
            <div className="md:col-span-2">
              <Combobox
                label="Item"
                value={line.itemId}
                options={itemOptions}
                loading={itemsLoading}
                onQueryChange={onItemSearch}
                placeholder="Search items (SKU/name)"
                required
                error={lineValidation[idx]?.errors.itemId}
                showSelectedValue={false}
                onChange={(nextValue) => {
                  const selected = nextValue ? itemLookup.get(nextValue) : undefined
                  onUpdateLine(idx, {
                    itemId: nextValue,
                    uom: selected?.defaultUom || line.uom || '',
                  })
                }}
              />
            </div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">
                UOM<span className="ml-0.5 text-red-500">*</span>
              </span>
              <Input
                value={line.uom}
                onChange={(e) => onUpdateLine(idx, { uom: e.target.value })}
                maxLength={12}
                placeholder={lineValidation[idx]?.defaultUom ?? 'e.g., kg'}
                aria-invalid={lineValidation[idx]?.errors.uom ? true : undefined}
                aria-describedby={lineValidation[idx]?.errors.uom ? `line-${idx}-uom-error` : undefined}
                className={cn(
                  lineValidation[idx]?.errors.uom ? 'border-red-400 focus:border-red-500 focus:ring-red-100' : undefined,
                )}
              />
              {lineValidation[idx]?.uomMismatch && lineValidation[idx]?.defaultUom && (
                <div className="text-xs text-amber-700">
                  Overrides default UOM ({lineValidation[idx]?.defaultUom}).
                </div>
              )}
              {lineValidation[idx]?.errors.uom && (
                <div id={`line-${idx}-uom-error`} className="text-xs text-red-600">
                  {lineValidation[idx]?.errors.uom}
                </div>
              )}
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">
                Quantity<span className="ml-0.5 text-red-500">*</span>
              </span>
              <Input
                type="number"
                min={0}
                value={line.quantityOrdered}
                onChange={(e) =>
                  onUpdateLine(idx, {
                    quantityOrdered: e.target.value === '' ? '' : Number(e.target.value),
                  })
                }
                aria-invalid={lineValidation[idx]?.errors.quantityOrdered ? true : undefined}
                aria-describedby={lineValidation[idx]?.errors.quantityOrdered ? `line-${idx}-qty-error` : undefined}
                className={cn(
                  lineValidation[idx]?.errors.quantityOrdered
                    ? 'border-red-400 focus:border-red-500 focus:ring-red-100'
                    : undefined,
                )}
              />
              {lineValidation[idx]?.errors.quantityOrdered && (
                <div id={`line-${idx}-qty-error`} className="text-xs text-red-600">
                  {lineValidation[idx]?.errors.quantityOrdered}
                </div>
              )}
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">
                Unit Price ({currencyCode})
              </span>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={line.unitPrice ?? ''}
                onChange={(e) =>
                  onUpdateLine(idx, {
                    unitPrice: e.target.value === '' ? '' : Number(e.target.value),
                  })
                }
                placeholder="0.00"
              />
            </label>
            <div className="space-y-1 text-sm">
              <div className="text-xs uppercase tracking-wide text-slate-500">Line Total ({currencyCode})</div>
              <div className="rounded-lg border border-transparent bg-slate-50 px-3 py-2 text-sm text-slate-900">
                {lineValidation[idx]?.lineTotal != null
                  ? formatCurrency(lineValidation[idx]?.lineTotal, currencyCode)
                  : '—'}
              </div>
            </div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
              <Textarea
                value={line.notes ?? ''}
                onChange={(e) => onUpdateLine(idx, { notes: e.target.value })}
                placeholder="Optional"
              />
            </label>
            {lines.length > 1 && (
              <div className="md:col-span-6">
                <Button variant="secondary" size="sm" onClick={() => onRemoveLine(idx)}>
                  Remove line
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <div>
          {lineStats.valid.length} line(s) ready · Total qty {formatNumber(lineStats.totalQty)}
        </div>
        <div className="text-sm font-semibold text-slate-700">
          Subtotal ({currencyCode}): {formatCurrency(subtotal, currencyCode)}
        </div>
      </div>
    </div>
  )
}
