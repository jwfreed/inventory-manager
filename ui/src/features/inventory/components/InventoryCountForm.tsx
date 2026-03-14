import type { ComboboxOption } from '@shared/ui'
import { Button, Combobox, Input, Select, Textarea } from '@shared/ui'

export type InventoryCountLineFormValue = {
  lineNumber: number
  itemId: string
  locationId: string
  uom: string
  countedQuantity: string
  unitCostForPositiveAdjustment: string
  reasonCode: string
  notes: string
}

export type InventoryCountFormValues = {
  countedAt: string
  warehouseId: string
  locationId: string
  notes: string
  lines: InventoryCountLineFormValue[]
}

type Props = {
  value: InventoryCountFormValues
  warehouseOptions: Array<{ value: string; label: string }>
  itemOptions: ComboboxOption[]
  locationOptions: ComboboxOption[]
  isLocked?: boolean
  isSubmitting?: boolean
  submitLabel: string
  onChange: <K extends keyof InventoryCountFormValues>(field: K, nextValue: InventoryCountFormValues[K]) => void
  onLineChange: (
    lineIndex: number,
    field: keyof InventoryCountLineFormValue,
    nextValue: string | number,
  ) => void
  onAddLine: () => void
  onRemoveLine: (lineIndex: number) => void
  onSubmit: () => void
}

export function createEmptyInventoryCountLine(lineNumber: number): InventoryCountLineFormValue {
  return {
    lineNumber,
    itemId: '',
    locationId: '',
    uom: '',
    countedQuantity: '',
    unitCostForPositiveAdjustment: '',
    reasonCode: '',
    notes: '',
  }
}

export function InventoryCountForm({
  value,
  warehouseOptions,
  itemOptions,
  locationOptions,
  isLocked = false,
  isSubmitting = false,
  submitLabel,
  onChange,
  onLineChange,
  onAddLine,
  onRemoveLine,
  onSubmit,
}: Props) {
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="grid gap-4 md:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Warehouse</span>
          <Select
            value={value.warehouseId}
            disabled={isLocked}
            onChange={(event) => onChange('warehouseId', event.target.value)}
          >
            <option value="">Select warehouse</option>
            {warehouseOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Counted at</span>
          <Input
            type="datetime-local"
            value={value.countedAt}
            disabled={isLocked}
            onChange={(event) => onChange('countedAt', event.target.value)}
          />
        </label>
        <Combobox
          label="Header location"
          value={value.locationId}
          options={locationOptions}
          disabled={isLocked}
          showSelectedValue={false}
          onChange={(next) => onChange('locationId', next)}
        />
      </div>

      <label className="space-y-1 text-sm">
        <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
        <Textarea
          value={value.notes}
          disabled={isLocked}
          onChange={(event) => onChange('notes', event.target.value)}
        />
      </label>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-900">Count lines</div>
            <div className="text-xs text-slate-500">
              Capture counted quantity, location, and any variance reason before posting.
            </div>
          </div>
          {!isLocked ? (
            <Button size="sm" variant="secondary" type="button" onClick={onAddLine}>
              Add line
            </Button>
          ) : null}
        </div>
        <div className="space-y-4">
          {value.lines.map((line, index) => (
            <div key={line.lineNumber} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-900">Line {line.lineNumber}</div>
                {!isLocked && value.lines.length > 1 ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    type="button"
                    onClick={() => onRemoveLine(index)}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Combobox
                  label="Item"
                  value={line.itemId}
                  options={itemOptions}
                  disabled={isLocked}
                  showSelectedValue={false}
                  onChange={(next) => onLineChange(index, 'itemId', next)}
                />
                <Combobox
                  label="Location"
                  value={line.locationId}
                  options={locationOptions}
                  disabled={isLocked}
                  showSelectedValue={false}
                  onChange={(next) => onLineChange(index, 'locationId', next)}
                />
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
                  <Input
                    value={line.uom}
                    disabled={isLocked}
                    onChange={(event) => onLineChange(index, 'uom', event.target.value)}
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Counted qty</span>
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    value={line.countedQuantity}
                    disabled={isLocked}
                    onChange={(event) => onLineChange(index, 'countedQuantity', event.target.value)}
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Positive adj. unit cost</span>
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    value={line.unitCostForPositiveAdjustment}
                    disabled={isLocked}
                    onChange={(event) =>
                      onLineChange(index, 'unitCostForPositiveAdjustment', event.target.value)
                    }
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Reason code</span>
                  <Input
                    value={line.reasonCode}
                    disabled={isLocked}
                    onChange={(event) => onLineChange(index, 'reasonCode', event.target.value)}
                  />
                </label>
                <label className="space-y-1 text-sm md:col-span-2">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Line notes</span>
                  <Textarea
                    value={line.notes}
                    disabled={isLocked}
                    onChange={(event) => onLineChange(index, 'notes', event.target.value)}
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end">
        <Button size="sm" type="submit" disabled={isLocked || isSubmitting}>
          {isSubmitting ? `${submitLabel}...` : submitLabel}
        </Button>
      </div>
    </form>
  )
}
