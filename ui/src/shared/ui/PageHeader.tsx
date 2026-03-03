import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

type Props = {
  title: string
  subtitle?: string
  meta?: ReactNode
  action?: ReactNode
  className?: string
}

export function PageHeader({ title, subtitle, meta, action, className }: Props) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-slate-600">{subtitle}</p> : null}
        {meta ? <div className="mt-2">{meta}</div> : null}
      </div>
      {action}
    </header>
  )
}
