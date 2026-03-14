import { Alert, Button } from '@shared/ui'

type Props = {
  canMarkReady: boolean
  canCancel: boolean
  canClose: boolean
  cancelDisabledReason?: string
  closeDisabledReason?: string
  isMarkReadyPending?: boolean
  isCancelPending?: boolean
  isClosePending?: boolean
  lifecycleMessage?: string | null
  lifecycleError?: string | null
  onMarkReady: () => void
  onRequestCancel: () => void
  onRequestClose: () => void
}

export function WorkOrderLifecycleActions({
  canMarkReady,
  canCancel,
  canClose,
  cancelDisabledReason,
  closeDisabledReason,
  isMarkReadyPending = false,
  isCancelPending = false,
  isClosePending = false,
  lifecycleMessage,
  lifecycleError,
  onMarkReady,
  onRequestCancel,
  onRequestClose,
}: Props) {
  const disabledReason = cancelDisabledReason || closeDisabledReason

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {canMarkReady ? (
          <Button size="sm" onClick={onMarkReady} disabled={isMarkReadyPending}>
            {isMarkReadyPending ? 'Marking ready...' : 'Mark ready'}
          </Button>
        ) : null}
        {canCancel ? (
          <Button size="sm" variant="danger" onClick={onRequestCancel} disabled={isCancelPending}>
            {isCancelPending ? 'Canceling...' : 'Cancel work order'}
          </Button>
        ) : null}
        {canClose ? (
          <Button size="sm" variant="secondary" onClick={onRequestClose} disabled={isClosePending}>
            {isClosePending ? 'Closing...' : 'Close work order'}
          </Button>
        ) : null}
      </div>
      {disabledReason && !canCancel && !canClose && !canMarkReady ? (
        <div className="text-right text-xs text-slate-500">{disabledReason}</div>
      ) : null}
      {lifecycleMessage ? <Alert variant="success" title="Lifecycle updated" message={lifecycleMessage} /> : null}
      {lifecycleError ? <Alert variant="error" title="Lifecycle update failed" message={lifecycleError} /> : null}
    </div>
  )
}
