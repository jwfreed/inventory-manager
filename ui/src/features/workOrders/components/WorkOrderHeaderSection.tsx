import type { Item } from '@api/types'
import { Combobox, Input, Section, Textarea } from '@shared/ui'
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
  items: Item[]
  itemsLoading: boolean
  selectedItem?: Item
  stageLabel?: string
  consumeLocationLabel?: string
  produceLocationLabel?: string
  isPending: boolean
  onDescriptionChange: (value: string) => void
  onOutputItemChange: (value: string) => void
  onOutputUomChange: (value: string) => void
  onQuantityPlannedChange: (value: number | '') => void
  onScheduledStartAtChange: (value: string) => void
  onScheduledDueAtChange: (value: string) => void
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
  items,
  itemsLoading,
  selectedItem,
  stageLabel,
  consumeLocationLabel = 'Auto-derived at save time',
  produceLocationLabel = 'Auto-derived at save time',
  isPending,
  onDescriptionChange,
  onOutputItemChange,
  onOutputUomChange,
  onQuantityPlannedChange,
  onScheduledStartAtChange,
  onScheduledDueAtChange,
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
        <div className="md:col-span-2">
          <Combobox
            label={itemLabel}
            value={outputItemId}
            options={items.map((item) => ({
              value: item.id,
              label: `${item.sku} — ${item.name}`,
              keywords: `${item.sku} ${item.name}`,
            }))}
            placeholder="Search items"
            disabled={isPending || itemsLoading}
            loading={itemsLoading}
            showSelectedValue={false}
            onChange={onOutputItemChange}
          />
        </div>
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
            type="text"
            value={scheduledStartAt}
            onChange={(e) => onScheduledStartAtChange(e.target.value)}
            placeholder="DD-MM-YY"
            disabled={isPending}
          />
        </FormField>
        <FormField label="Scheduled due">
          <Input
            type="text"
            value={scheduledDueAt}
            onChange={(e) => onScheduledDueAtChange(e.target.value)}
            placeholder="DD-MM-YY"
            disabled={isPending}
          />
        </FormField>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <FormField label="Production stage">
          <Input value={stageLabel || 'Auto-derived'} disabled />
        </FormField>
        <FormField label="Consume location">
          <Input value={consumeLocationLabel} disabled />
        </FormField>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <FormField label="Produce location">
          <Input value={produceLocationLabel} disabled />
        </FormField>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
          Locations are derived from the work-order stage and are locked for operators.
        </div>
      </div>
    </Section>
  )
}
