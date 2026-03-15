import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { InventoryTransferResult } from '@api/types'
import { Alert, Button, Panel } from '@shared/ui'

type Props = {
  validationMessages: string[]
  errorMessage?: string | null
  result?: InventoryTransferResult | null
  children: ReactNode
  onReset: () => void
}

export function TransferOperationPanel({
  validationMessages,
  errorMessage,
  result,
  children,
  onReset,
}: Props) {
  return (
    <Panel
      title="Transfer details"
      description="Use this screen for direct operational transfers. Negative overrides are intentionally unavailable."
    >
      {validationMessages.length > 0 ? (
        <Alert
          variant="warning"
          title="Resolve transfer inputs"
          message={validationMessages.join(' ')}
        />
      ) : null}
      {errorMessage ? <Alert variant="error" title="Transfer failed" message={errorMessage} /> : null}
      {result ? (
        <div className="space-y-3">
          <Alert
            variant="success"
            title="Transfer posted"
            message={
              result.replayed
                ? 'Inventory transfer replayed successfully from the existing idempotent request.'
                : 'Inventory transfer posted successfully.'
            }
            action={
              <div className="flex flex-wrap gap-2">
                {result.movementId ? (
                  <Link to={`/movements/${result.movementId}`}>
                    <Button size="sm" variant="secondary">
                      View movement
                    </Button>
                  </Link>
                ) : null}
                <Button size="sm" variant="secondary" onClick={onReset}>
                  New transfer
                </Button>
              </div>
            }
          />
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
            <div className="font-semibold text-slate-900">Transfer receipt</div>
            <div className="mt-1">Transfer ID: {result.transferId}</div>
            <div className="mt-1">Movement ID: {result.movementId ?? 'Unavailable'}</div>
            <div className="mt-1">Replay state: {result.replayed ? 'Replayed' : 'Posted'}</div>
          </div>
        </div>
      ) : null}
      {children}
    </Panel>
  )
}
