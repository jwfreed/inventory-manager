import { Button, Input, SearchableSelect } from '@shared/ui'
import { cn } from '@lib/utils'
import type { AdjustmentLineDraft } from '../types'

type LineError = {
  itemId?: string
  locationId?: string
  uom?: string
  quantityDelta?: string
}

type Option = {
  value: string
  label: string
  keywords?: string
}

type Props = {
  lines: AdjustmentLineDraft[]
  itemOptions: Option[]
  locationOptions: Option[]
  lockItemId?: string | null
  lockLocationId?: string | null
  lineErrors?: Record<string, LineError>
  showErrors?: boolean
  onLineChange: (index: number, patch: Partial<AdjustmentLineDraft>) => void
  onAddLine: () => void
  onDuplicateLine: (index: number) => void
  onRemoveLine: (index: number) => void
}

export function AdjustmentLinesEditor({
  lines,
  itemOptions,
  locationOptions,
  lockItemId,
  lockLocationId,
  lineErrors,
  showErrors,
  onLineChange,
  onAddLine,
  onDuplicateLine,
  onRemoveLine,
}: Props) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        Signed quantities: positive adds stock (found/correction), negative removes stock (shrinkage/damage).
      </div>
      {lines.map((line, idx) => {
        const errors = lineErrors?.[line.key]
        return (
          <div key={line.key} className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-6">
            <div className="md:col-span-2">
              <SearchableSelect
                label="Item"
                value={line.itemId}
                options={itemOptions}
                disabled={Boolean(lockItemId)}
                onChange={(value) => onLineChange(idx, { itemId: value })}
              />
              {showErrors && errors?.itemId && (
                <div className="mt-1 text-xs text-red-600">{errors.itemId}</div>
              )}
            </div>
            <div className="md:col-span-2">
              <SearchableSelect
                label="Location"
                value={line.locationId}
                options={locationOptions}
                disabled={Boolean(lockLocationId)}
                onChange={(value) => onLineChange(idx, { locationId: value })}
              />
              {showErrors && errors?.locationId && (
                <div className="mt-1 text-xs text-red-600">{errors.locationId}</div>
              )}
            </div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
              <Input
                value={line.uom}
                onChange={(e) => onLineChange(idx, { uom: e.target.value })}
                className={cn(showErrors && errors?.uom ? 'border-red-400' : undefined)}
              />
              {showErrors && errors?.uom && (
                <div className="text-xs text-red-600">{errors.uom}</div>
              )}
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Quantity Δ</span>
              <Input
                type="number"
                step="any"
                value={line.quantityDelta}
                onChange={(e) =>
                  onLineChange(idx, {
                    quantityDelta: e.target.value === '' ? '' : Number(e.target.value),
                  })
                }
                className={cn(showErrors && errors?.quantityDelta ? 'border-red-400' : undefined)}
              />
              {showErrors && errors?.quantityDelta && (
                <div className="text-xs text-red-600">{errors.quantityDelta}</div>
              )}
            </label>
            <div className="md:col-span-2">
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Line notes</span>
                <Input
                  value={line.notes}
                  onChange={(e) => onLineChange(idx, { notes: e.target.value })}
                />
              </label>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" type="button" onClick={() => onDuplicateLine(idx)}>
                  Duplicate
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() => onRemoveLine(idx)}
                  disabled={lines.length <= 1}
                >
                  Remove
                </Button>
              </div>
            </div>
          </div>
        )
      })}
      <Button variant="secondary" size="sm" type="button" onClick={onAddLine}>
        Add line
      </Button>
    </div>
  )
}
