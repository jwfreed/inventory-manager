import { useMemo, useState } from 'react'
import { Button, FilterBar, Input, Select, ActiveFiltersSummary } from '@shared/ui'
import type { MovementListParams } from '../api/ledger'

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
  const activeFilters = useMemo(
    () =>
      [
        filters.occurredFrom ? { key: 'occurredFrom', label: 'From', value: filters.occurredFrom } : null,
        filters.occurredTo ? { key: 'occurredTo', label: 'To', value: filters.occurredTo } : null,
        filters.movementType ? { key: 'movementType', label: 'Type', value: filters.movementType } : null,
        filters.status ? { key: 'status', label: 'Status', value: filters.status } : null,
        filters.externalRef ? { key: 'externalRef', label: 'Reference', value: filters.externalRef } : null,
        filters.itemId ? { key: 'itemId', label: 'Item', value: filters.itemId } : null,
        filters.locationId ? { key: 'locationId', label: 'Location', value: filters.locationId } : null,
      ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    [filters],
  )

  const handleChange = (key: keyof MovementListParams, value: string) => {
    setFilters((prev) => ({
      ...prev,
      [key]: value || undefined,
      offset: 0,
    }))
  }

  const reset = () => {
    const next: MovementListParams = { limit: filters.limit, offset: 0 }
    setFilters(next)
    onApply(next)
  }

  return (
    <FilterBar
      actions={
        <>
          <Button variant="primary" size="sm" onClick={() => onApply(filters)} disabled={disabled}>
            Apply filters
          </Button>
          <Button variant="secondary" size="sm" onClick={reset} disabled={disabled}>
            Reset
          </Button>
        </>
      }
      helperText="Use item, location, and date filters to trace stock movements for a specific scope."
      summary={
        <ActiveFiltersSummary
          filters={activeFilters}
          onClearOne={(key) => handleChange(key as keyof MovementListParams, '')}
          onClearAll={reset}
        />
      }
    >
      <div className="grid w-full gap-3 md:grid-cols-3">
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
            Item ID
          </label>
          <Input
            placeholder="Filter item"
            value={filters.itemId || ''}
            onChange={(e) => handleChange('itemId', e.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Location ID
          </label>
          <Input
            placeholder="Filter location"
            value={filters.locationId || ''}
            onChange={(e) => handleChange('locationId', e.target.value)}
            disabled={disabled}
          />
        </div>
      </div>
    </FilterBar>
  )
}
