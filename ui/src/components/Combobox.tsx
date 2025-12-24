import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { cn } from '../lib/utils'

export type ComboboxOption = {
  value: string
  label: string
  description?: string
  keywords?: string
}

type Props = {
  label: string
  value: string
  options: ComboboxOption[]
  placeholder?: string
  disabled?: boolean
  loading?: boolean
  emptyMessage?: string
  onChange: (nextValue: string) => void
  onQueryChange?: (query: string) => void
}

export function Combobox({
  label,
  value,
  options,
  placeholder,
  disabled,
  loading,
  emptyMessage,
  onChange,
  onQueryChange,
}: Props) {
  const id = useId()
  const listId = `${id}-listbox`
  const containerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [inputValue, setInputValue] = useState('')
  const [isFocused, setIsFocused] = useState(false)

  const selectedOption = useMemo(
    () => options.find((opt) => opt.value === value),
    [options, value],
  )

  const selectionLabel = useMemo(() => {
    if (selectedOption?.label) return selectedOption.label
    return value
  }, [selectedOption, value])

  const displayValue = isFocused ? inputValue : selectionLabel

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setActiveIndex(-1)
        setIsFocused(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [])

  const filteredOptions = useMemo(() => {
    if (onQueryChange) return options
    const needle = inputValue.trim().toLowerCase()
    if (!needle) return options
    return options.filter((opt) => {
      const hay = `${opt.label} ${opt.keywords ?? ''}`.toLowerCase()
      return hay.includes(needle)
    })
  }, [inputValue, onQueryChange, options])

  const openList = () => {
    if (disabled) return
    setOpen(true)
    setIsFocused(true)
  }

  const closeList = () => {
    setOpen(false)
    setActiveIndex(-1)
  }

  const handleInputChange = (next: string) => {
    setInputValue(next)
    onQueryChange?.(next)
    if (!next) onChange('')
    if (!open) setOpen(true)
  }

  const handleSelect = (opt: ComboboxOption) => {
    onChange(opt.value)
    setInputValue(opt.label)
    closeList()
    inputRef.current?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      setOpen(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((prev) => Math.min(prev + 1, filteredOptions.length - 1))
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((prev) => Math.max(prev - 1, 0))
    }
    if (event.key === 'Enter') {
      if (activeIndex >= 0 && filteredOptions[activeIndex]) {
        event.preventDefault()
        handleSelect(filteredOptions[activeIndex])
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeList()
    }
  }

  return (
    <label ref={containerRef} className="space-y-1 text-sm">
      <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
      <div className="relative">
        <input
          ref={inputRef}
          className={cn(
            'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-slate-50',
            open ? 'border-brand-300' : undefined,
          )}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
          placeholder={placeholder ?? 'Search...'}
          value={displayValue}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={() => {
            openList()
            if (onQueryChange) {
              const selectedLabel = selectionLabel
              const nextQuery =
                value && inputValue === selectedLabel ? '' : inputValue
              onQueryChange(nextQuery)
            }
            setInputValue(selectionLabel)
          }}
          onBlur={() => {
            setInputValue(selectionLabel)
            setIsFocused(false)
            closeList()
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          autoComplete="off"
        />
        {open && (
          <div
            id={listId}
            role="listbox"
            className="absolute z-20 mt-2 w-full rounded-lg border border-slate-200 bg-white shadow-lg"
          >
            {loading && (
              <div className="px-3 py-2 text-xs text-slate-500">Loading...</div>
            )}
            {!loading && filteredOptions.length === 0 && (
              <div className="px-3 py-2 text-xs text-slate-500">
                {emptyMessage ?? 'No matches'}
              </div>
            )}
            {!loading &&
              filteredOptions.map((opt, idx) => {
                const active = idx === activeIndex
                return (
                  <button
                    key={opt.value}
                    id={`${listId}-opt-${idx}`}
                    type="button"
                    role="option"
                    aria-selected={value === opt.value}
                    className={cn(
                      'w-full px-3 py-2 text-left text-sm',
                      active ? 'bg-brand-50 text-brand-900' : 'text-slate-700 hover:bg-slate-50',
                    )}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      handleSelect(opt)
                    }}
                  >
                    <div className="font-medium text-slate-900">{opt.label}</div>
                    {opt.description && (
                      <div className="text-xs text-slate-500">{opt.description}</div>
                    )}
                  </button>
                )
              })}
          </div>
        )}
      </div>
      {value && (
        <div className="text-xs text-slate-500">
          Selected: <span className="font-mono">{value}</span>
        </div>
      )}
    </label>
  )
}
