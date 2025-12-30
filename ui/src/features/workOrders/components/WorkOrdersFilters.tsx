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
  isFetching: boolean
  onStatusChange: (next: string) => void
  onSearchChange: (next: string) => void
  onPlannedDateChange: (next: string) => void
  onRefresh: () => void
}

export function WorkOrdersFilters({
  status,
  search,
  plannedDate,
  isFetching,
  onStatusChange,
  onSearchChange,
  onPlannedDateChange,
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
