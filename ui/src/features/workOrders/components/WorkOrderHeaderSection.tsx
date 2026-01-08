import type { Item } from '@api/types'
import { Input, Section, Textarea } from '@shared/ui'
import { FormField } from '../../../components/FormField'

export type SelectOption = {
  value: string
  label: string
}

type Props = {
  description: string
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
  onDescriptionChange: (value: string) => void
  onOutputItemChange: (value: string) => void
  onOutputUomChange: (value: string) => void
  onQuantityPlannedChange: (value: number | '') => void
  onScheduledStartAtChange: (value: string) => void
  onScheduledDueAtChange: (value: string) => void
  onDefaultConsumeLocationChange: (value: string) => void
  onDefaultProduceLocationChange: (value: string) => void
}

export function WorkOrderHeaderSection({
  description,
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
  onDescriptionChange,
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
      <div className="grid gap-3">
        <FormField label="Description">
          <Textarea
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="Optional note for humans"
            disabled={isPending}
          />
        </FormField>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <FormField label={itemLabel} className="md:col-span-2">
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
        </FormField>
        <FormField label="Unit of measure" helper={selectedItem?.defaultUom && outputUom === selectedItem.defaultUom ? 'Auto from item default UOM' : undefined}>
          <Input
            value={outputUom}
            onChange={(e) => onOutputUomChange(e.target.value)}
            placeholder="ea"
            required
            disabled={isPending}
          />
        </FormField>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <FormField label={quantityLabel} error={quantityError || undefined}>
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
        </FormField>
        <FormField label="Scheduled start">
          <Input
            type="date"
            value={scheduledStartAt}
            onChange={(e) => onScheduledStartAtChange(e.target.value)}
            disabled={isPending}
          />
        </FormField>
        <FormField label="Scheduled due">
          <Input
            type="date"
            value={scheduledDueAt}
            onChange={(e) => onScheduledDueAtChange(e.target.value)}
            disabled={isPending}
          />
        </FormField>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <FormField label="Default consume location" helper={selectedItem?.defaultLocationId && defaultConsumeLocationId === selectedItem.defaultLocationId ? 'Auto from item default location' : undefined}>
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
        </FormField>
        <FormField label="Default produce location" helper={selectedItem?.defaultLocationId && defaultProduceLocationId === selectedItem.defaultLocationId ? 'Auto from item default location' : undefined}>
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
        </FormField>
      </div>
    </Section>
  )
}
