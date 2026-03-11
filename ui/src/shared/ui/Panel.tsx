import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

export type PanelProps = {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: PanelProps) {
  return (
    <section
      className={cn(
        'rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-950/5',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
        </div>
        {actions}
      </div>
      <div className={cn('px-5 py-4', bodyClassName)}>{children}</div>
    </section>
  )
}
