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
      description="Post a balanced source and destination movement without using inventory adjustment."
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
            {result.movements?.length ? (
              <div className="mt-2 space-y-1">
                {result.movements.map((movement) => (
                  <div key={`${movement.type}:${movement.locationId}`}>
                    {movement.quantity > 0 ? '+' : ''}
                    {movement.quantity} {movement.uom} {movement.type === 'transfer_out' ? 'from' : 'to'} {movement.locationId}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {children}
    </Panel>
  )
}
