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
  onSubmitIntent: () => void
  onSave: () => void
  onCancel: () => void
}

export function PurchaseOrderActionBar({
  isEditable,
  isReadyToSubmit,
  isLocked,
  isBusy,
  submitPending,
  savePending,
  canCancel,
  onSubmitIntent,
  onSave,
  onCancel,
}: Props) {
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {isEditable && (
        <Button size="sm" onClick={onSubmitIntent} disabled={!isReadyToSubmit || isBusy}>
          {submitPending ? 'Submitting…' : 'Submit PO for approval'}
        </Button>
      )}
      <Button size="sm" variant="secondary" onClick={onSave} disabled={isLocked || isBusy}>
        {savePending ? 'Saving…' : 'Save draft'}
      </Button>
      {canCancel && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            if (confirm('Cancel this purchase order?')) {
              onCancel()
            }
          }}
          disabled={isBusy}
        >
          Cancel
        </Button>
      )}
      <Link to="/purchase-orders">
        <Button variant="secondary" size="sm">
          Back to list
        </Button>
      </Link>
      <Link to="/purchase-orders/new">
        <Button variant="secondary" size="sm">
          New PO
        </Button>
      </Link>
    </div>
  )
}
