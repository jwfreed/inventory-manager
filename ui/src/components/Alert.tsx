import type { ReactNode } from 'react'
import { cn } from '../lib/utils'

type AlertVariant = 'success' | 'warning' | 'error' | 'info'

const variantStyles: Record<AlertVariant, string> = {
  success: 'border-green-200 bg-green-50 text-green-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  error: 'border-red-200 bg-red-50 text-red-800',
  info: 'border-sky-200 bg-sky-50 text-sky-800',
}

type Props = {
  title?: string
  message?: string
  variant?: AlertVariant
  action?: ReactNode
  className?: string
}

export function Alert({ title, message, variant = 'info', action, className }: Props) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-sm',
        variantStyles[variant],
        className,
      )}
    >
      <div className="flex-1">
        {title && <div className="font-semibold">{title}</div>}
        {message && <div className="mt-1 text-sm leading-relaxed">{message}</div>}
      </div>
      {action}
    </div>
  )
}
