import type { ComboboxOption } from '@shared/ui'
import { Button, Combobox, Input, Textarea } from '@shared/ui'

export type InventoryTransferFormValues = {
  itemId: string
  sourceLocationId: string
  destinationLocationId: string
  quantity: string
  uom: string
  occurredAt: string
  reasonCode: string
  notes: string
}

type Props = {
  value: InventoryTransferFormValues
  itemOptions: ComboboxOption[]
  locationOptions: ComboboxOption[]
  isSubmitting?: boolean
  isDisabled?: boolean
  onChange: <K extends keyof InventoryTransferFormValues>(
    field: K,
    nextValue: InventoryTransferFormValues[K],
  ) => void
  onSubmit: () => void
}

export function InventoryTransferForm({
  value,
  itemOptions,
  locationOptions,
  isSubmitting = false,
  isDisabled = false,
  onChange,
  onSubmit,
}: Props) {
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Combobox
          label="Item"
          value={value.itemId}
          options={itemOptions}
          required
          disabled={isDisabled}
          showSelectedValue={false}
          onChange={(next) => onChange('itemId', next)}
        />
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
          <Input
            value={value.uom}
            required
            disabled={isDisabled}
            onChange={(event) => onChange('uom', event.target.value)}
          />
        </label>
        <Combobox
          label="Source location"
          value={value.sourceLocationId}
          options={locationOptions}
          required
          disabled={isDisabled}
          showSelectedValue={false}
          onChange={(next) => onChange('sourceLocationId', next)}
        />
        <Combobox
          label="Destination location"
          value={value.destinationLocationId}
          options={locationOptions}
          required
          disabled={isDisabled}
          showSelectedValue={false}
          onChange={(next) => onChange('destinationLocationId', next)}
        />
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Quantity</span>
          <Input
            type="number"
            min="0"
            step="any"
            value={value.quantity}
            required
            disabled={isDisabled}
            onChange={(event) => onChange('quantity', event.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Occurred at</span>
          <Input
            type="datetime-local"
            value={value.occurredAt}
            disabled={isDisabled}
            onChange={(event) => onChange('occurredAt', event.target.value)}
          />
        </label>
      </div>

      <label className="space-y-1 text-sm">
        <span className="text-xs uppercase tracking-wide text-slate-500">Reason code</span>
        <Input
          value={value.reasonCode}
          disabled={isDisabled}
          onChange={(event) => onChange('reasonCode', event.target.value)}
        />
      </label>

      <label className="space-y-1 text-sm">
        <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
        <Textarea
          value={value.notes}
          disabled={isDisabled}
          onChange={(event) => onChange('notes', event.target.value)}
        />
      </label>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
        Negative inventory overrides are intentionally not exposed from this screen.
      </div>

      <div className="flex justify-end">
        <Button size="sm" type="submit" disabled={isSubmitting || isDisabled}>
          {isSubmitting ? 'Posting transfer...' : 'Post transfer'}
        </Button>
      </div>
    </form>
  )
}
