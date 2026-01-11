// Helper functions and icons for bulk operations

export const BulkActionIcons = {
  accept: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  ),
  hold: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
      />
    </svg>
  ),
  reject: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  ),
}

export type BulkAction = {
  id: string
  label: string
  icon: JSX.Element
  variant: 'primary' | 'secondary' | 'danger'
  onClick: () => void
  disabled?: boolean
}

export function createQcBulkActions(handlers: {
  onBulkAccept: () => void
  onBulkHold: () => void
  onBulkReject: () => void
  isProcessing: boolean
}): BulkAction[] {
  return [
    {
      id: 'accept',
      label: 'Accept Selected',
      icon: BulkActionIcons.accept,
      variant: 'primary' as const,
      onClick: handlers.onBulkAccept,
      disabled: handlers.isProcessing,
    },
    {
      id: 'hold',
      label: 'Hold Selected',
      icon: BulkActionIcons.hold,
      variant: 'secondary' as const,
      onClick: handlers.onBulkHold,
      disabled: handlers.isProcessing,
    },
    {
      id: 'reject',
      label: 'Reject Selected',
      icon: BulkActionIcons.reject,
      variant: 'danger' as const,
      onClick: handlers.onBulkReject,
      disabled: handlers.isProcessing,
    },
  ]
}
