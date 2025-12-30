import type { Item } from '@api/types'
import { Input, Section, Textarea } from '@shared/ui'

export type SelectOption = {
  value: string
  label: string
}

type Props = {
  workOrderNumber: string
  notes: string
  outputItemId: string
  outputUom: string
  quantityPlanned: number | ''
  quantityError: string | null
  itemLabel?: string
  quantityLabel?: string
  scheduledStartAt: string
  scheduledDueAt: string
  defaultConsumeLocationId: string
  defaultProduceLocationId: string
  items: Item[]
  itemsLoading: boolean
  locationsLoading: boolean
  selectedItem?: Item
  locationOptions: SelectOption[]
  consumeMissing: boolean
  produceMissing: boolean
  isPending: boolean
  onWorkOrderNumberChange: (value: string) => void
  onNotesChange: (value: string) => void
  onOutputItemChange: (value: string) => void
  onOutputUomChange: (value: string) => void
  onQuantityPlannedChange: (value: number | '') => void
  onScheduledStartAtChange: (value: string) => void
  onScheduledDueAtChange: (value: string) => void
  onDefaultConsumeLocationChange: (value: string) => void
  onDefaultProduceLocationChange: (value: string) => void
}

export function WorkOrderHeaderSection({
  workOrderNumber,
  notes,
  outputItemId,
  outputUom,
  quantityPlanned,
  quantityError,
  itemLabel = 'Item to make',
  quantityLabel = 'Quantity planned',
  scheduledStartAt,
  scheduledDueAt,
  defaultConsumeLocationId,
  defaultProduceLocationId,
  items,
  itemsLoading,
  locationsLoading,
  selectedItem,
  locationOptions,
  consumeMissing,
  produceMissing,
  isPending,
  onWorkOrderNumberChange,
  onNotesChange,
  onOutputItemChange,
  onOutputUomChange,
  onQuantityPlannedChange,
  onScheduledStartAtChange,
  onScheduledDueAtChange,
  onDefaultConsumeLocationChange,
  onDefaultProduceLocationChange,
}: Props) {
  return (
    <Section title="Header">
      <div className="grid gap-3 md:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Work order number</span>
          <Input
            value={workOrderNumber}
            onChange={(e) => onWorkOrderNumberChange(e.target.value)}
            required
            disabled={isPending}
          />
        </label>
        <label className="space-y-1 text-sm md:col-span-2">
          <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
          <Textarea
            value={notes}
            onChange={(e) => onNotesChange(e.target.value)}
            placeholder="Optional"
            disabled={isPending}
          />
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="space-y-1 text-sm md:col-span-2">
          <span className="text-xs uppercase tracking-wide text-slate-500">{itemLabel}</span>
          <select
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={outputItemId}
            onChange={(e) => onOutputItemChange(e.target.value)}
            disabled={isPending || itemsLoading}
          >
            <option value="">Select item</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.sku} — {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Unit of measure</span>
          <Input
            value={outputUom}
            onChange={(e) => onOutputUomChange(e.target.value)}
            placeholder="ea"
            required
            disabled={isPending}
          />
          {selectedItem?.defaultUom && outputUom === selectedItem.defaultUom && (
            <p className="text-xs text-slate-500">Auto from item default UOM</p>
          )}
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">{quantityLabel}</span>
          <Input
            type="number"
            min={1}
            value={quantityPlanned}
            onChange={(e) => {
              const next = e.target.value === '' ? '' : Number(e.target.value)
              onQuantityPlannedChange(next)
            }}
            required
            disabled={isPending}
          />
          {quantityError ? <p className="text-xs text-red-600">{quantityError}</p> : null}
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Scheduled start</span>
          <Input
            type="date"
            value={scheduledStartAt}
            onChange={(e) => onScheduledStartAtChange(e.target.value)}
            disabled={isPending}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Scheduled due</span>
          <Input
            type="date"
            value={scheduledDueAt}
            onChange={(e) => onScheduledDueAtChange(e.target.value)}
            disabled={isPending}
          />
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Default consume location</span>
          <select
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={defaultConsumeLocationId}
            onChange={(e) => onDefaultConsumeLocationChange(e.target.value)}
            disabled={isPending || locationsLoading}
          >
            <option value="">None</option>
            {locationOptions.map((loc) => (
              <option key={loc.value} value={loc.value}>
                {loc.label}
              </option>
            ))}
            {consumeMissing && <option value={defaultConsumeLocationId}>Current selection</option>}
          </select>
          {selectedItem?.defaultLocationId && defaultConsumeLocationId === selectedItem.defaultLocationId && (
            <p className="text-xs text-slate-500">Auto from item default location</p>
          )}
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Default produce location</span>
          <select
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={defaultProduceLocationId}
            onChange={(e) => onDefaultProduceLocationChange(e.target.value)}
            disabled={isPending || locationsLoading}
          >
            <option value="">None</option>
            {locationOptions.map((loc) => (
              <option key={loc.value} value={loc.value}>
                {loc.label}
              </option>
            ))}
            {produceMissing && <option value={defaultProduceLocationId}>Current selection</option>}
          </select>
          {selectedItem?.defaultLocationId && defaultProduceLocationId === selectedItem.defaultLocationId && (
            <p className="text-xs text-slate-500">Auto from item default location</p>
          )}
        </label>
      </div>
    </Section>
  )
}
