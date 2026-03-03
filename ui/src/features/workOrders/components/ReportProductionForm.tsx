import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Alert, Button, Card, Input, Textarea } from '@shared/ui'
import type { ApiError, WorkOrder } from '@api/types'
import { reportWorkOrderProduction } from '../api/workOrders'
import { v4 as uuidv4 } from 'uuid'

type Props = {
  workOrder: WorkOrder
  onRefetch: (options?: { showSummaryToast?: boolean }) => void
}

function toIsoOrNow(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString()
  return parsed.toISOString()
}

export function ReportProductionForm({ workOrder, onRefetch }: Props) {
  const remaining = Math.max(0, (workOrder.quantityPlanned || 0) - (workOrder.quantityCompleted ?? 0))
  const [outputQty, setOutputQty] = useState<number | ''>(remaining > 0 ? remaining : '')
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 16))
  const [notes, setNotes] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const clientRequestIdRef = useRef<string | null>(null)

  const receiveToLabel = workOrder.reportProductionReceiveToLocationName
    ? `${workOrder.reportProductionReceiveToLocationName} (${workOrder.reportProductionReceiveToLocationCode ?? workOrder.reportProductionReceiveToLocationId})`
    : (workOrder.reportProductionReceiveToLocationCode ?? workOrder.reportProductionReceiveToLocationId ?? 'Warehouse QA default')
  const receiveToSource =
    workOrder.reportProductionReceiveToSource === 'routing_snapshot'
      ? 'Routing snapshot'
      : workOrder.reportProductionReceiveToSource === 'work_order_default'
        ? 'Work order default'
        : 'Warehouse default'

  const clearClientRequestId = () => {
    clientRequestIdRef.current = null
  }

  const mutation = useMutation({
    mutationFn: (clientRequestId: string) =>
      reportWorkOrderProduction(workOrder.id, {
        outputQty: Number(outputQty),
        outputUom: workOrder.outputUom,
        occurredAt: toIsoOrNow(occurredAt),
        notes: notes.trim() || undefined,
        clientRequestId
      }),
    onSuccess: (result) => {
      clientRequestIdRef.current = null
      setFormError(null)
      setSuccessMessage(
        `Posted issue movement ${result.componentIssueMovementId} and receipt movement ${result.productionReceiptMovementId}.`
      )
      onRefetch({ showSummaryToast: true })
    },
    onError: (error: ApiError | unknown) => {
      const message = (error as ApiError)?.message ?? 'Failed to report production.'
      setFormError(message)
    }
  })

  const disabled = workOrder.status === 'canceled' || workOrder.status === 'completed' || mutation.isPending

  const submit = () => {
    if (!(Number(outputQty) > 0)) {
      setFormError('Produced quantity must be greater than zero.')
      return
    }
    if (!clientRequestIdRef.current) {
      clientRequestIdRef.current = uuidv4()
    }
    setSuccessMessage(null)
    mutation.mutate(clientRequestIdRef.current)
  }

  return (
    <Card>
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Report Production</h3>
          <p className="mt-1 text-xs text-slate-600">
            One-click backflush: consume components by BOM and receive output automatically.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">Produced quantity</label>
            <Input
              type="number"
              min="0.000001"
              step="0.000001"
              value={outputQty}
              onChange={(event) => {
                const next = event.target.value
                clearClientRequestId()
                setOutputQty(next === '' ? '' : Number(next))
              }}
              disabled={disabled}
            />
            <p className="mt-1 text-[11px] text-slate-500">UOM: {workOrder.outputUom}</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">Occurred at</label>
            <Input
              type="datetime-local"
              value={occurredAt}
              onChange={(event) => {
                clearClientRequestId()
                setOccurredAt(event.target.value)
              }}
              disabled={disabled}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">Remaining to complete</label>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              {remaining} {workOrder.outputUom}
            </div>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">Note (optional)</label>
          <Textarea
            value={notes}
            onChange={(event) => {
              clearClientRequestId()
              setNotes(event.target.value)
            }}
            placeholder="Reference, operator note, or batch context"
            className="min-h-[88px]"
            disabled={disabled}
          />
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          Receive-to location: <span className="font-semibold">{receiveToLabel}</span> ({receiveToSource})
        </div>

        {formError && <Alert variant="error" title="Report failed" message={formError} />}
        {successMessage && <Alert variant="success" title="Production reported" message={successMessage} />}

        <div className="flex justify-end">
          <Button onClick={submit} disabled={disabled}>
            {mutation.isPending ? 'Posting...' : 'Report Production'}
          </Button>
        </div>
      </div>
    </Card>
  )
}
