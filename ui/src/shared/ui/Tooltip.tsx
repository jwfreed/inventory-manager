import { InformationCircleIcon } from '@heroicons/react/24/outline'
import { useId, useState } from 'react'
import { cn } from '../../lib/utils'

type Props = {
  label: string
  className?: string
}

export function Tooltip({ label, className }: Props) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span className={cn('relative inline-flex', className)}>
      <button
        type="button"
        className="rounded-full text-slate-500 hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <InformationCircleIcon className="h-4 w-4" aria-hidden="true" />
      </button>
      {open ? (
        <span
          id={id}
          role="tooltip"
          className="absolute left-1/2 top-full z-20 mt-2 w-56 -translate-x-1/2 rounded-md border border-slate-200 bg-white p-2 text-xs text-slate-700 shadow-lg"
        >
          {label}
        </span>
      ) : null}
    </span>
  )
}
