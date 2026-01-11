import { Button, Card } from '@shared/ui'
import { formatNumber } from '@shared/formatters'
import type { ReactNode } from 'react'

type BulkAction = {
  id: string
  label: string
  icon: ReactNode
  variant: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
  confirmMessage?: string
}

type Props = {
  selectedCount: number
  totalCount: number
  actions: BulkAction[]
  onAction: (actionId: string) => void | Promise<void>
  onClearSelection: () => void
  isProcessing?: boolean
  className?: string
}

export function BulkOperationsBar({
  selectedCount,
  totalCount,
  actions,
  onAction,
  onClearSelection,
  isProcessing = false,
  className,
}: Props) {
  if (selectedCount === 0) {
    return null
  }

  const handleAction = async (action: BulkAction) => {
    if (action.disabled || isProcessing) return

    if (action.confirmMessage) {
      if (!window.confirm(action.confirmMessage)) {
        return
      }
    }

    await onAction(action.id)
  }

  return (
    <Card className={className}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
        {/* Selection Info */}
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-indigo-100 flex-shrink-0">
            <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">
              {formatNumber(selectedCount)} {selectedCount === 1 ? 'item' : 'items'} selected
            </div>
            <div className="text-xs text-slate-500">
              {formatNumber(totalCount)} total
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((action) => (
            <Button
              key={action.id}
              variant={action.variant}
              size="sm"
              onClick={() => handleAction(action)}
              disabled={action.disabled || isProcessing}
              className="flex-shrink-0"
            >
              <span className="mr-1.5">{action.icon}</span>
              <span className="hidden sm:inline">{action.label}</span>
            </Button>
          ))}

          <div className="hidden sm:block w-px h-6 bg-slate-200 mx-1" />

          <Button
            variant="secondary"
            size="sm"
            onClick={onClearSelection}
            disabled={isProcessing}
            className="flex-shrink-0"
          >
            <span className="hidden sm:inline">Clear Selection</span>
            <span className="sm:hidden">Clear</span>
          </Button>
        </div>

        {/* Processing Indicator */}
        {isProcessing && (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            Processing...
          </div>
        )}
      </div>
    </Card>
  )
}

// Icon components for common bulk actions
export const BulkActionIcons = {
  accept: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  ),
  hold: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  ),
  reject: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  ),
  delete: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  ),
  print: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
    </svg>
  ),
  export: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
  ),
  putaway: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
    </svg>
  ),
}

// Pre-configured bulk action templates
export function createQcBulkActions(selectedCount: number, hasReasonRequired: boolean = false) {
  return [
    {
      id: 'bulk-accept',
      label: 'Accept All',
      icon: BulkActionIcons.accept,
      variant: 'primary' as const,
      confirmMessage: `Accept ${selectedCount} ${selectedCount === 1 ? 'line' : 'lines'}?`,
    },
    {
      id: 'bulk-hold',
      label: 'Hold All',
      icon: BulkActionIcons.hold,
      variant: 'secondary' as const,
      disabled: hasReasonRequired,
      confirmMessage: hasReasonRequired 
        ? undefined 
        : `Place ${selectedCount} ${selectedCount === 1 ? 'line' : 'lines'} on hold?`,
    },
    {
      id: 'bulk-reject',
      label: 'Reject All',
      icon: BulkActionIcons.reject,
      variant: 'danger' as const,
      disabled: hasReasonRequired,
      confirmMessage: hasReasonRequired 
        ? undefined 
        : `Reject ${selectedCount} ${selectedCount === 1 ? 'line' : 'lines'}?`,
    },
  ]
}

export function createReceiptBulkActions(selectedCount: number) {
  return [
    {
      id: 'bulk-print',
      label: 'Print',
      icon: BulkActionIcons.print,
      variant: 'secondary' as const,
    },
    {
      id: 'bulk-export',
      label: 'Export',
      icon: BulkActionIcons.export,
      variant: 'secondary' as const,
    },
    {
      id: 'bulk-putaway',
      label: 'Create Putaways',
      icon: BulkActionIcons.putaway,
      variant: 'primary' as const,
      confirmMessage: `Create putaways for ${selectedCount} ${selectedCount === 1 ? 'receipt' : 'receipts'}?`,
    },
  ]
}
