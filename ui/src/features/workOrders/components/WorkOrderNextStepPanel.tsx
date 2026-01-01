import type { ComboboxOption } from '@shared/ui'
import { Button, Card, Combobox } from '@shared/ui'
import type { ApiError } from '@api/types'

type Props = {
  isOpen: boolean
  selectedBomId: string
  nextQuantity: number | ''
  nextBomOptions: ComboboxOption[]
  isLoading: boolean
  isError: boolean
  error?: ApiError | null
  createWarning: string | null
  consumeLocationHint: string
  onBomChange: (value: string) => void
  onQuantityChange: (value: number | '') => void
  onCreate: () => void
  onCancel: () => void
}

export function WorkOrderNextStepPanel({
  isOpen,
  selectedBomId,
  nextQuantity,
  nextBomOptions,
  isLoading,
  isError,
  error,
  createWarning,
  consumeLocationHint,
  onBomChange,
  onQuantityChange,
  onCreate,
  onCancel,
}: Props) {
  if (!isOpen) return null

  return (
    <Card title="Continue production" description="Create the next work order from the active BOM.">
      <div className="space-y-3">
        <div className="text-sm text-slate-700">
          Suggests BOMs where this output is a component. Consume location defaults to this work
          order’s production location.
        </div>
        <div className="grid gap-3 md:grid-cols-3">
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
