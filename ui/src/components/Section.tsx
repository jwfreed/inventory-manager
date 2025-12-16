import type { ReactNode } from 'react'
import { cn } from '../lib/utils'

type Props = {
  title?: string
  description?: string
  children: ReactNode
  className?: string
}

export function Section({ title, description, children, className }: Props) {
  return (
    <section className={cn('space-y-2', className)}>
      {title && <h2 className="text-lg font-semibold text-slate-900">{title}</h2>}
      {description && <p className="text-sm text-slate-500">{description}</p>}
      <div>{children}</div>
    </section>
  )
}
