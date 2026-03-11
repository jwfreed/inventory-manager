import { XMarkIcon } from '@heroicons/react/24/outline'
import { Button } from '../../components/Button'
import { cn } from '../../lib/utils'

export type FilterChip = {
  key: string
  label: string
  value: string
}

export type ActiveFiltersSummaryProps = {
  filters: FilterChip[]
  onClearOne?: (key: string) => void
  onClearAll?: () => void
  className?: string
}

export function ActiveFiltersSummary({
  filters,
  onClearOne,
  onClearAll,
  className,
}: ActiveFiltersSummaryProps) {
  if (filters.length === 0) return null

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {filters.map((filter) => (
        <span
          key={filter.key}
          className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700"
        >
          <span className="text-slate-500">{filter.label}:</span>
          <span>{filter.value}</span>
          {onClearOne ? (
            <button
              type="button"
              className="rounded-full p-0.5 text-slate-400 transition hover:bg-slate-200 hover:text-slate-600"
              onClick={() => onClearOne(filter.key)}
              aria-label={`Clear ${filter.label}`}
            >
              <XMarkIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </span>
      ))}
      {onClearAll ? (
        <Button variant="secondary" size="sm" onClick={onClearAll}>
          Clear all
        </Button>
      ) : null}
    </div>
  )
}
