import type { ReactNode } from 'react'
import { cn } from '../lib/utils'

type Props = {
  title: string
  description?: string
  icon?: ReactNode
  action?: ReactNode
  className?: string
}

export function EmptyState({ title, description, icon, action, className }: Props) {
  return (
    <div className={cn('rounded-xl border border-dashed border-slate-200 bg-white p-6', className)}>
      <div className="flex items-start gap-3">
        {icon && <div className="text-slate-500">{icon}</div>}
        <div className="flex-1">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
          {action && <div className="mt-4">{action}</div>}
        </div>
      </div>
    </div>
  )
}
