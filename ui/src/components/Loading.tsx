import { cn } from '../lib/utils'

type Props = {
  label?: string
  className?: string
}

export function LoadingSpinner({ label = 'Loading...', className }: Props) {
  return (
    <div className={cn('flex items-center gap-2 text-sm text-slate-600', className)}>
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
      <span>{label}</span>
    </div>
  )
}

export function LoadingSkeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-slate-200', className)} />
}
