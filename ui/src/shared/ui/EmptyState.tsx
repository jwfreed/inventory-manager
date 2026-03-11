import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

export type EmptyStateProps = {
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('rounded-2xl border border-dashed border-slate-200 bg-white p-5', className)}>
      <div className="flex-1">
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    </div>
  )
}
