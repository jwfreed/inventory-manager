import type { WorkOrder } from '@api/types'
import { Alert, Button, Modal } from '@shared/ui'

type Props = {
  isOpen: boolean
  workOrder?: WorkOrder | null
  isPending?: boolean
  errorMessage?: string | null
  onCancel: () => void
  onConfirm: () => void
}

export function WorkOrderCancelModal({
  isOpen,
  workOrder,
  isPending = false,
  errorMessage,
  onCancel,
  onConfirm,
}: Props) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={workOrder?.number ? `Cancel Work Order ${workOrder.number}?` : 'Cancel Work Order?'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={isPending}>
            Keep Work Order
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm} disabled={isPending}>
            {isPending ? 'Canceling...' : 'Confirm Cancel Work Order'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-700">
          Canceling releases open reservations and prevents further execution from the UI. Posted
          inventory movements are not reversed by this action.
        </p>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
          <div className="font-semibold text-slate-900">{workOrder?.number ?? 'Work order'}</div>
          <div className="mt-1">Status: {workOrder?.status ?? 'Unknown'}</div>
          <div className="mt-1">Use this only before production begins.</div>
        </div>
        {errorMessage ? <Alert variant="error" title="Cancel failed" message={errorMessage} /> : null}
      </div>
    </Modal>
  )
}
