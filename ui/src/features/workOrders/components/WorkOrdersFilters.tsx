import { ActiveFiltersSummary, Button, FilterBar } from '@shared/ui'

const statusOptions = [
  { label: 'All statuses', value: '' },
  { label: 'Draft', value: 'draft' },
  { label: 'Ready', value: 'ready' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Partially Completed', value: 'partially_completed' },
  { label: 'Completed', value: 'completed' },
  { label: 'Closed', value: 'closed' },
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
  onReset: () => void
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
  onReset,
}: Props) {
  const filters = [
    status ? { key: 'status', label: 'Status', value: status.replace(/_/g, ' ') } : null,
    search ? { key: 'search', label: 'Search', value: search } : null,
    plannedDate ? { key: 'plannedDate', label: 'Planned date', value: plannedDate } : null,
    kind ? { key: 'kind', label: 'Kind', value: kind } : null,
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))

  return (
    <FilterBar
      actions={
        <>
          <Button variant="secondary" size="sm" onClick={onReset}>
            Reset
          </Button>
          <Button variant="secondary" size="sm" onClick={onRefresh}>
            Refresh
          </Button>
        </>
      }
      summary={
        <ActiveFiltersSummary
          filters={filters}
          onClearOne={(key) => {
            if (key === 'status') onStatusChange('')
            if (key === 'search') onSearchChange('')
            if (key === 'plannedDate') onPlannedDateChange('')
            if (key === 'kind') onKindChange('')
          }}
          onClearAll={onReset}
        />
      }
    >
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
          type="text"
          placeholder="DD-MM-YY"
          value={plannedDate}
          onChange={(e) => onPlannedDateChange(e.target.value)}
          disabled={isFetching}
        />
    </FilterBar>
  )
}
