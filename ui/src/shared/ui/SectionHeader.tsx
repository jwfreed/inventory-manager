import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

type Props = {
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

export function SectionHeader({ title, description, action, className }: Props) {
  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <div>
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
      </div>
      {action}
    </div>
  )
}
