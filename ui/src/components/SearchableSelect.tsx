import { useId, useMemo } from 'react'

export type SearchableSelectOption = {
  value: string
  label: string
  keywords?: string
}

type Props = {
  label: string
  value: string
  options: SearchableSelectOption[]
  placeholder?: string
  disabled?: boolean
  onChange: (nextValue: string) => void
}

export function SearchableSelect({
  label,
  value,
  options,
  placeholder,
  disabled,
  onChange,
}: Props) {
  const id = useId()
  const listId = `${id}-list`

  const optionMap = useMemo(() => {
    const map = new Map<string, SearchableSelectOption>()
    options.forEach((opt) => map.set(opt.value, opt))
    return map
  }, [options])

  const displayValue = useMemo(() => {
    if (!value) return ''
    const opt = optionMap.get(value)
    return opt ? `${opt.label} (${opt.value})` : value
  }, [optionMap, value])

  const onInputChange = (next: string) => {
    if (!next) {
      onChange('')
      return
    }
    const match = options.find((opt) => `${opt.label} (${opt.value})` === next)
    if (match) {
      onChange(match.value)
      return
    }
    if (optionMap.has(next)) {
      onChange(next)
      return
    }
  }

  return (
    <label className="space-y-1 text-sm">
      <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
      <input
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
        list={listId}
        value={displayValue}
        onChange={(e) => onInputChange(e.target.value)}
        placeholder={placeholder ?? 'Search…'}
        disabled={disabled}
      />
      <datalist id={listId}>
        {options.map((opt) => (
          <option key={opt.value} value={`${opt.label} (${opt.value})`}>
            {opt.keywords ?? ''}
          </option>
        ))}
      </datalist>
      {value && (
        <div className="text-xs text-slate-500">
          Selected: <span className="font-mono">{value}</span>
        </div>
      )}
    </label>
  )
}

