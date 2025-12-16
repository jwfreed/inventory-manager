import { useState } from 'react'
import { Button } from '../../../components/Button'
import { Input, Select } from '../../../components/Inputs'
import type { MovementListParams } from '../../../api/endpoints/ledger'

type Props = {
  initialFilters: MovementListParams
  onApply: (filters: MovementListParams) => void
  disabled?: boolean
}

const movementTypeOptions = [
  { label: 'Any type', value: '' },
  { label: 'Receive', value: 'receive' },
  { label: 'Issue', value: 'issue' },
  { label: 'Transfer', value: 'transfer' },
  { label: 'Adjustment', value: 'adjustment' },
  { label: 'Count', value: 'count' },
]

const statusOptions = [
  { label: 'Any status', value: '' },
  { label: 'Draft', value: 'draft' },
  { label: 'Posted', value: 'posted' },
  { label: 'Canceled', value: 'canceled' },
]

export function MovementFilters({ initialFilters, onApply, disabled }: Props) {
  const [filters, setFilters] = useState<MovementListParams>(initialFilters)

  const handleChange = (key: keyof MovementListParams, value: string) => {
    setFilters((prev) => ({
      ...prev,
      [key]: value || undefined,
      offset: 0,
    }))
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Occurred from
          </label>
          <Input
            type="date"
            value={filters.occurredFrom || ''}
            onChange={(e) => handleChange('occurredFrom', e.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Occurred to
          </label>
          <Input
            type="date"
            value={filters.occurredTo || ''}
            onChange={(e) => handleChange('occurredTo', e.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Movement type
          </label>
          <Select
            value={filters.movementType || ''}
            onChange={(e) => handleChange('movementType', e.target.value)}
            disabled={disabled}
          >
            {movementTypeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Status
          </label>
          <Select
            value={filters.status || ''}
            onChange={(e) => handleChange('status', e.target.value)}
            disabled={disabled}
          >
            {statusOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            External reference
          </label>
          <Input
            placeholder="Search external ref"
            value={filters.externalRef || ''}
            onChange={(e) => handleChange('externalRef', e.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Item filter
          </label>
          <Input placeholder="Not available (backend not exposed)" value="" disabled />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          onClick={() => onApply(filters)}
          disabled={disabled}
        >
          Apply filters
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            const reset: MovementListParams = { limit: filters.limit, offset: 0 }
            setFilters(reset)
            onApply(reset)
          }}
          disabled={disabled}
        >
          Reset
        </Button>
        <span className="text-xs text-slate-500">
          Item/location filters are hidden until backend exposes them.
        </span>
      </div>
    </div>
  )
}
