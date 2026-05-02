import { Link } from 'react-router-dom'
import { Button } from '@shared/ui'

type Props = {
  isEditable: boolean
  isReadyToSubmit: boolean
  isLocked: boolean
  isBusy: boolean
  submitPending: boolean
  savePending: boolean
  canCancel: boolean
  canClose: boolean
  canCreate: boolean
  canWrite: boolean
  onSubmitIntent: () => void
  onSave: () => void
  onCancelRequest: () => void
  onCloseRequest: () => void
}

export function PurchaseOrderActionBar({
  isEditable,
  isReadyToSubmit,
  isLocked,
  isBusy,
  submitPending,
  savePending,
  canCancel,
  canClose,
  canCreate,
  canWrite,
  onSubmitIntent,
  onSave,
  onCancelRequest,
  onCloseRequest,
}: Props) {
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {isEditable && canWrite && (
        <Button size="sm" onClick={onSubmitIntent} disabled={!isReadyToSubmit || isBusy}>
          {submitPending ? 'Submitting…' : 'Submit PO for approval'}
        </Button>
      )}
      {canWrite ? (
        <Button size="sm" variant="secondary" onClick={onSave} disabled={isLocked || isBusy}>
          {savePending ? 'Saving…' : 'Save draft'}
        </Button>
      ) : null}
      {canCancel && (
        <Button size="sm" variant="secondary" onClick={onCancelRequest} disabled={isBusy}>
          Cancel
        </Button>
      )}
      {canClose && (
        <Button size="sm" variant="secondary" onClick={onCloseRequest} disabled={isBusy}>
          Close PO
        </Button>
      )}
      <Link to="/purchase-orders">
        <Button variant="secondary" size="sm">
          Back to list
        </Button>
      </Link>
      {canCreate ? (
        <Link to="/purchase-orders/new">
          <Button variant="secondary" size="sm">
            New PO
          </Button>
        </Link>
      ) : null}
    </div>
  )
}
