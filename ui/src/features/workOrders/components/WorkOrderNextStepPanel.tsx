import type { ComboboxOption } from '../../../components/Combobox'
import { Combobox } from '../../../components/Combobox'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import type { ApiError } from '../../../api/types'

type Props = {
  isOpen: boolean
  nextWorkOrderNumber: string
  selectedBomId: string
  nextQuantity: number | ''
  nextBomOptions: ComboboxOption[]
  isLoading: boolean
  isError: boolean
  error?: ApiError | null
  createWarning: string | null
  consumeLocationHint: string
  onWorkOrderNumberChange: (value: string) => void
  onBomChange: (value: string) => void
  onQuantityChange: (value: number | '') => void
  onCreate: () => void
  onCancel: () => void
}

export function WorkOrderNextStepPanel({
  isOpen,
  nextWorkOrderNumber,
  selectedBomId,
  nextQuantity,
  nextBomOptions,
  isLoading,
  isError,
  error,
  createWarning,
  consumeLocationHint,
  onWorkOrderNumberChange,
  onBomChange,
  onQuantityChange,
  onCreate,
  onCancel,
}: Props) {
  if (!isOpen) return null

  return (
    <Card>
      <div className="space-y-3">
        <div className="text-sm text-slate-700">
          Suggests BOMs where this WO output is a component. Defaults consume location to this WO's
          production location and falls back to the item default location.
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Work order number</span>
            <input
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={nextWorkOrderNumber}
              onChange={(e) => onWorkOrderNumberChange(e.target.value)}
            />
          </label>
          <label className="space-y-1 text-sm md:col-span-2">
            <Combobox
              label="Next BOM"
              value={selectedBomId}
              options={nextBomOptions}
              loading={isLoading}
              disabled={isLoading}
              placeholder="Search suggested BOMs"
              emptyMessage="No suggested BOMs"
              onChange={onBomChange}
            />
            {isError && (
              <p className="text-xs text-red-600">{error?.message ?? 'Failed to load suggestions.'}</p>
            )}
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Quantity planned</span>
            <input
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              type="number"
              min={0}
              value={nextQuantity}
              onChange={(e) => onQuantityChange(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </label>
          <div className="text-sm text-slate-600 md:col-span-2">{consumeLocationHint}</div>
        </div>
        {createWarning && <div className="text-sm text-red-600">{createWarning}</div>}
        <div className="flex gap-2">
          <Button size="sm" onClick={onCreate} disabled={isLoading}>
            Create next-step WO
          </Button>
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  )
}
