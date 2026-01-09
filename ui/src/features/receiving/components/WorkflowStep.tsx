import { Badge } from '@shared/ui'
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline'
import { useState, useEffect } from 'react'

type StepVariant = 'complete' | 'current' | 'blocked' | 'pending'

type Props = {
  stepNumber: number
  label: string
  variant: StepVariant
  blockedReason?: string
  summary?: string
  defaultExpanded?: boolean
  children?: React.ReactNode
}

export function WorkflowStep({
  stepNumber,
  label,
  variant,
  blockedReason,
  summary,
  defaultExpanded = false,
  children,
}: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  // Auto-expand when variant becomes 'current'
  useEffect(() => {
    if (variant === 'current') {
      setExpanded(true)
    }
  }, [variant])

  const badgeConfig = {
    complete: { variant: 'success' as const, label: 'Done' },
    current: { variant: 'info' as const, label: 'Current' },
    blocked: { variant: 'warning' as const, label: 'Blocked' },
    pending: { variant: 'neutral' as const, label: 'Pending' },
  }[variant]

  const isInteractive = variant === 'current' || variant === 'complete'

  return (
    <div className="rounded-md border border-slate-200 bg-white overflow-hidden">
      <button
        type="button"
        className={`w-full px-3 py-2.5 text-left transition-colors ${
          isInteractive ? 'hover:bg-slate-50 cursor-pointer' : 'cursor-default'
        } ${variant === 'current' ? 'bg-brand-50' : ''}`}
        onClick={() => isInteractive && setExpanded(!expanded)}
        disabled={!isInteractive}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div
              className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${
                variant === 'complete'
                  ? 'bg-green-100 text-green-700'
                  : variant === 'current'
                    ? 'bg-brand-100 text-brand-700'
                    : variant === 'blocked'
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-slate-100 text-slate-500'
              }`}
            >
              {stepNumber}
            </div>
            <div className="min-w-0 flex-1">
              <div
                className={`text-sm font-semibold ${
                  variant === 'complete'
                    ? 'text-slate-700'
                    : variant === 'current'
                      ? 'text-slate-900'
                      : 'text-slate-500'
                }`}
              >
                {label}
              </div>
              {summary && variant === 'complete' && !expanded && (
                <div className="text-xs text-slate-500 truncate">{summary}</div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={badgeConfig.variant}>{badgeConfig.label}</Badge>
            {isInteractive && (
              <div className="flex-shrink-0">
                {expanded ? (
                  <ChevronDownIcon className="w-4 h-4 text-slate-400" />
                ) : (
                  <ChevronRightIcon className="w-4 h-4 text-slate-400" />
                )}
              </div>
            )}
          </div>
        </div>
        {blockedReason && (
          <div className="mt-1.5 text-xs text-amber-700 pl-8">{blockedReason}</div>
        )}
      </button>
      {expanded && children && (
        <div className="px-3 pb-3 pt-1 border-t border-slate-100 bg-white">
          {children}
        </div>
      )}
    </div>
  )
}
