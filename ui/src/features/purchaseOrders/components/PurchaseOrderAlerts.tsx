import { Link } from 'react-router-dom'
import { Alert, Button } from '@shared/ui'

type Props = {
  isLocked: boolean
  statusLabel: string
  canReceive: boolean
  submitError?: string | null
  approveError?: string | null
  saveError?: string | null
  submitMessage?: string | null
  approveMessage?: string | null
  saveMessage?: string | null
}

export function PurchaseOrderAlerts({
  isLocked,
  statusLabel,
  canReceive,
  submitError,
  approveError,
  saveError,
  submitMessage,
  approveMessage,
  saveMessage,
}: Props) {
  const hasAlerts =
    isLocked || submitError || approveError || saveError || submitMessage || approveMessage || saveMessage

  if (!hasAlerts) return null

  return (
    <div className="mt-3 space-y-2">
      {isLocked && (
        <Alert
          variant="info"
          title="Locked"
          message={`This PO is ${statusLabel.toLowerCase()} and read-only. Use Repeat to create a new draft if changes are needed.`}
        />
      )}
      {submitError && <Alert variant="error" title="Submission failed" message={submitError} />}
      {approveError && <Alert variant="error" title="Approval failed" message={approveError} />}
      {saveError && <Alert variant="error" title="Save failed" message={saveError} />}
      {submitMessage && (
        <Alert
          variant="success"
          title={statusLabel.toLowerCase() === 'approved' ? 'PO approved' : 'PO submitted'}
          message={submitMessage}
          action={
            canReceive ? (
              <Link to="/receiving">
                <Button size="sm" variant="secondary">
                  Go to Receiving
                </Button>
              </Link>
            ) : undefined
          }
        />
      )}
      {approveMessage && (
        <Alert
          variant="success"
          title="PO approved"
          message={approveMessage}
          action={
            <Link to="/receiving">
              <Button size="sm" variant="secondary">
                Go to Receiving
              </Button>
            </Link>
          }
        />
      )}
      {saveMessage && <Alert variant="success" title="Draft saved" message={saveMessage} />}
    </div>
  )
}
