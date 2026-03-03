import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils'
import { severityTokens, type Severity } from './severity'

type Props = HTMLAttributes<HTMLSpanElement> & {
  severity: Severity
  label?: string
}

export function SeverityPill({ severity, label, className, ...props }: Props) {
  const token = severityTokens[severity]
  const Icon = token.icon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold',
        token.pillClassName,
        className,
      )}
      {...props}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{label ?? token.label}</span>
    </span>
  )
}
