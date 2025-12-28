import { Link } from 'react-router-dom'
import { Button } from '@shared/ui'

type Props = {
  isEditable: boolean
  isReadyToSubmit: boolean
  isLocked: boolean
  isBusy: boolean
  submitPending: boolean
  savePending: boolean
  onSubmitIntent: () => void
  onSave: () => void
  onDelete: () => void
}

export function PurchaseOrderActionBar({
  isEditable,
  isReadyToSubmit,
  isLocked,
  isBusy,
  submitPending,
  savePending,
  onSubmitIntent,
  onSave,
  onDelete,
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
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          if (confirm('Delete this purchase order?')) {
            onDelete()
          }
        }}
        disabled={isBusy}
      >
        Delete
      </Button>
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
