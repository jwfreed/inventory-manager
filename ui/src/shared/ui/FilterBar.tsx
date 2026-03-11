import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

type Props = {
  children?: ReactNode
  actions?: ReactNode
  summary?: ReactNode
  helperText?: ReactNode
  className?: string
}

export function FilterBar({ children, actions, summary, helperText, className }: Props) {
  return (
    <div className={cn('space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm', className)}>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
      {actions || helperText ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">{actions}</div>
          {helperText ? <div className="text-xs text-slate-500">{helperText}</div> : null}
        </div>
      ) : null}
      {summary}
    </div>
  )
}
