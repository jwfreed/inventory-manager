import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { severityTokens, type Severity } from './severity'

type Props = {
  severity?: Severity
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

export function Banner({
  severity = 'info',
  title,
  description,
  action,
  className,
}: Props) {
  const token = severityTokens[severity]
  const Icon = token.icon
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-3 rounded-xl border px-4 py-3',
        token.borderClassName,
        token.tintClassName,
        className,
      )}
    >
      <Icon className={cn('mt-0.5 h-5 w-5 flex-none', token.textClassName)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-900">{title}</p>
        {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
      </div>
      {action}
    </div>
  )
}
