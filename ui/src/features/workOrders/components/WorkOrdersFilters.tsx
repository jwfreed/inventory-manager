import { Button, FilterBar, Section } from '@shared/ui'

const statusOptions = [
  { label: 'All statuses', value: '' },
  { label: 'Draft', value: 'draft' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
  { label: 'Canceled', value: 'canceled' },
]

type Props = {
  status: string
  search: string
  plannedDate: string
  kind: string
  isFetching: boolean
  onStatusChange: (next: string) => void
  onSearchChange: (next: string) => void
  onPlannedDateChange: (next: string) => void
  onKindChange: (next: string) => void
  onRefresh: () => void
}

export function WorkOrdersFilters({
  status,
  search,
  plannedDate,
  kind,
  isFetching,
  onStatusChange,
  onSearchChange,
  onPlannedDateChange,
  onKindChange,
  onRefresh,
}: Props) {
  return (
    <Section title="Filters">
      <FilterBar>
        <select
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
          value={status}
          onChange={(e) => onStatusChange(e.target.value)}
          disabled={isFetching}
        >
          {statusOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <input
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
          placeholder="Search work order or item"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          disabled={isFetching}
        />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {[
            { label: 'All', value: '' },
            { label: 'Production', value: 'production' },
            { label: 'Disassembly', value: 'disassembly' },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              className={`rounded-full border px-3 py-1 font-semibold uppercase tracking-wide ${
                kind === option.value
                  ? 'border-brand-400 bg-brand-50 text-brand-700'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300'
              }`}
              onClick={() => onKindChange(option.value)}
              disabled={isFetching}
            >
              {option.label}
            </button>
          ))}
        </div>
        <input
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
          type="date"
          value={plannedDate}
          onChange={(e) => onPlannedDateChange(e.target.value)}
          disabled={isFetching}
        />
        <Button variant="secondary" size="sm" onClick={onRefresh}>
          Refresh
        </Button>
      </FilterBar>
    </Section>
  )
}
