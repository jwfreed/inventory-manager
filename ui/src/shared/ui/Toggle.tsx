import { cn } from '../../lib/utils'

export type ToggleOption<T extends string> = {
  value: T
  label: string
}

type Props<T extends string> = {
  ariaLabel: string
  options: Array<ToggleOption<T>>
  value: T
  onChange: (value: T) => void
  className?: string
}

export function Toggle<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
  className,
}: Props<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn('inline-flex rounded-lg border border-slate-200 bg-white p-1', className)}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500',
              active ? 'bg-blue-600 text-white' : 'text-slate-700 hover:bg-slate-50',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
