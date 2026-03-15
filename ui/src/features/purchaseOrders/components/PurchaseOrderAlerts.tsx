import { Link } from 'react-router-dom'
import { ActionGuardMessage, Alert, Button } from '@shared/ui'

type Props = {
  isLocked: boolean
  statusLabel: string
  canReceive: boolean
  submitError?: string | null
  approveError?: string | null
  saveError?: string | null
  closeError?: string | null
  submitMessage?: string | null
  approveMessage?: string | null
  saveMessage?: string | null
  closeMessage?: string | null
}

export function PurchaseOrderAlerts({
  isLocked,
  statusLabel,
  canReceive,
  submitError,
  approveError,
  saveError,
  closeError,
  submitMessage,
  approveMessage,
  saveMessage,
  closeMessage,
}: Props) {
  const hasAlerts =
    isLocked ||
    submitError ||
    approveError ||
    saveError ||
    closeError ||
    submitMessage ||
    approveMessage ||
    saveMessage ||
    closeMessage

  if (!hasAlerts) return null

  return (
    <div className="mt-3 space-y-2">
      {isLocked && (
        <ActionGuardMessage
          title="Locked"
          message={`This PO is ${statusLabel.toLowerCase()} and read-only. Use Repeat to create a new draft if changes are needed.`}
        />
      )}
      {submitError && <Alert variant="error" title="Submission failed" message={submitError} />}
      {approveError && <Alert variant="error" title="Approval failed" message={approveError} />}
      {saveError && <Alert variant="error" title="Save failed" message={saveError} />}
      {closeError && <Alert variant="error" title="Close failed" message={closeError} />}
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
      {closeMessage && <Alert variant="success" title="PO updated" message={closeMessage} />}
    </div>
  )
}
