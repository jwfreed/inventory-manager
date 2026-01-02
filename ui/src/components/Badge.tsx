import type { HTMLAttributes } from 'react'
import { cn } from '../lib/utils'

type BadgeVariant = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

const variantStyles: Record<BadgeVariant, string> = {
  neutral: 'bg-slate-50 text-slate-600 ring-1 ring-inset ring-slate-500/10',
  success: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20',
  warning: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/20',
  danger: 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-600/20',
  info: 'bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-700/10',
}

type Props = HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant
}

export function Badge({ className, variant = 'neutral', ...props }: Props) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold',
        variantStyles[variant],
        className,
      )}
      {...props}
    />
  )
}
