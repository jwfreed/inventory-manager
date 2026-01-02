import { Button, Combobox, type ComboboxOption, Input, Textarea } from '@shared/ui'
import type { Item } from '@api/types'
import type { PurchaseOrderLineDraft, PurchaseOrderLineStats } from '../types'

export type ItemOption = ComboboxOption

type Props = {
  lines: PurchaseOrderLineDraft[]
  itemOptions: ItemOption[]
  itemLookup: Map<string, Item>
  itemsLoading: boolean
  lineStats: PurchaseOrderLineStats
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
          <div key={idx} className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-6">
            <div className="md:col-span-2">
              <Combobox
                label="Item"
                value={line.itemId}
                options={itemOptions}
                loading={itemsLoading}
                onQueryChange={onItemSearch}
                placeholder="Search items (SKU/name)"
                onChange={(nextValue) => {
                  const selected = nextValue ? itemLookup.get(nextValue) : undefined
                  onUpdateLine(idx, {
                    itemId: nextValue,
                    uom: line.uom || selected?.defaultUom || '',
                  })
                }}
              />
            </div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
              <Input value={line.uom} onChange={(e) => onUpdateLine(idx, { uom: e.target.value })} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Quantity</span>
              <Input
                type="number"
                min={0}
                value={line.quantityOrdered}
                onChange={(e) =>
                  onUpdateLine(idx, {
                    quantityOrdered: e.target.value === '' ? '' : Number(e.target.value),
                  })
                }
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Unit Price</span>
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
      <div className="mt-2 text-xs text-slate-500">
        {lineStats.valid.length} line(s) ready · Total qty {lineStats.totalQty}
      </div>
    </div>
  )
}
