import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { createReturnAuthorization } from '../api/returns'
import { orderToCashQueryKeys } from '../queries'
import { formatReturnOperationError } from '../lib/returnOperationErrorMessaging'
import { logOperationalMutationFailure } from '../../../lib/operationalLogging'
import { Alert, Button, Input, PageHeader, Panel, Select, Textarea } from '@shared/ui'

type ReturnLineDraft = {
  lineNumber?: number
  salesOrderLineId?: string
  itemId: string
  uom: string
  quantityAuthorized: number | ''
  reasonCode?: string
  notes?: string
}

const statusOptions = ['draft', 'authorized', 'closed', 'canceled'] as const

export default function ReturnAuthorizationPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [rmaNumber, setRmaNumber] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [salesOrderId, setSalesOrderId] = useState('')
  const [status, setStatus] = useState<(typeof statusOptions)[number]>('draft')
  const [severity, setSeverity] = useState('')
  const [authorizedAt, setAuthorizedAt] = useState('')
  const [notes, setNotes] = useState('')
  const [warning, setWarning] = useState<string | null>(null)
  const [lines, setLines] = useState<ReturnLineDraft[]>([
    { lineNumber: 1, itemId: '', uom: '', quantityAuthorized: '' },
  ])

  const mutation = useMutation({
    mutationFn: () =>
      createReturnAuthorization({
        rmaNumber,
        customerId,
        salesOrderId: salesOrderId || undefined,
        status,
        severity: severity || undefined,
        authorizedAt: authorizedAt ? new Date(authorizedAt).toISOString() : undefined,
        notes: notes || undefined,
        lines: lines
          .filter((line) => line.itemId && line.uom && Number(line.quantityAuthorized) > 0)
          .map((line, index) => ({
            lineNumber: line.lineNumber ?? index + 1,
            salesOrderLineId: line.salesOrderLineId || undefined,
            itemId: line.itemId,
            uom: line.uom,
            quantityAuthorized: Number(line.quantityAuthorized),
            reasonCode: line.reasonCode || undefined,
            notes: line.notes || undefined,
          })),
      }),
    onSuccess: async (returnDoc) => {
      await queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.returns.all })
      navigate(`/returns/${returnDoc.id}`)
    },
    onError: (err) => {
      logOperationalMutationFailure('returns', 'create-authorization', err, { rmaNumber, customerId })
      setWarning(formatReturnOperationError(err, 'Failed to create return authorization.'))
    },
  })

  const updateLine = (index: number, patch: Partial<ReturnLineDraft>) => {
    setLines((current) => current.map((line, lineIndex) => (lineIndex === index ? { ...line, ...patch } : line)))
  }

  const removeLine = (index: number) => {
    setLines((current) =>
      current
        .filter((_, lineIndex) => lineIndex !== index)
        .map((line, lineIndex) => ({ ...line, lineNumber: lineIndex + 1 })),
    )
  }

  const submit = () => {
    if (!rmaNumber.trim() || !customerId.trim()) {
      setWarning('RMA number and customer ID are required.')
      return
    }
    if (!lines.some((line) => line.itemId && line.uom && Number(line.quantityAuthorized) > 0)) {
      setWarning('Add at least one return line with an item, UOM, and positive quantity.')
      return
    }
    setWarning(null)
    mutation.mutate()
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="New return authorization"
        subtitle="Authorize the return first. Receipt and disposition execution happen on the return detail workflow."
        action={
          <Button variant="secondary" size="sm" onClick={() => navigate('/returns')}>
            Back to returns
          </Button>
        }
      />

      <Panel title="Authorization header" description="This screen creates the return authorization document only.">
        {warning ? <Alert variant="warning" title="Check required fields" message={warning} /> : null}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <label className="block space-y-1">
            <span className="text-xs uppercase tracking-wide text-slate-500">RMA number</span>
            <Input value={rmaNumber} onChange={(event) => setRmaNumber(event.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs uppercase tracking-wide text-slate-500">Customer ID</span>
            <Input value={customerId} onChange={(event) => setCustomerId(event.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs uppercase tracking-wide text-slate-500">Sales order ID</span>
            <Input
              value={salesOrderId}
              onChange={(event) => setSalesOrderId(event.target.value)}
              placeholder="Optional"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs uppercase tracking-wide text-slate-500">Status</span>
            <Select value={status} onChange={(event) => setStatus(event.target.value as (typeof statusOptions)[number])}>
              {statusOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs uppercase tracking-wide text-slate-500">Severity</span>
            <Input value={severity} onChange={(event) => setSeverity(event.target.value)} placeholder="Optional" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs uppercase tracking-wide text-slate-500">Authorized at</span>
            <Input
              type="datetime-local"
              value={authorizedAt}
              onChange={(event) => setAuthorizedAt(event.target.value)}
            />
          </label>
          <label className="block space-y-1 md:col-span-2">
            <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
        </div>
      </Panel>

      <Panel title="Return lines" description="Use one line per item authorized for return.">
        <div className="space-y-3">
          {lines.map((line, index) => (
            <div key={index} className="grid gap-3 rounded-xl border border-slate-200 p-4 md:grid-cols-3 xl:grid-cols-6">
              <label className="block space-y-1">
                <span className="text-xs uppercase tracking-wide text-slate-500">Line #</span>
                <Input
                  type="number"
                  min={1}
                  value={line.lineNumber ?? index + 1}
                  onChange={(event) =>
                    updateLine(index, {
                      lineNumber: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs uppercase tracking-wide text-slate-500">Sales order line ID</span>
                <Input
                  value={line.salesOrderLineId || ''}
                  onChange={(event) => updateLine(index, { salesOrderLineId: event.target.value })}
                  placeholder="Optional"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs uppercase tracking-wide text-slate-500">Item ID</span>
                <Input value={line.itemId} onChange={(event) => updateLine(index, { itemId: event.target.value })} />
              </label>
              <label className="block space-y-1">
                <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
                <Input value={line.uom} onChange={(event) => updateLine(index, { uom: event.target.value })} />
              </label>
              <label className="block space-y-1">
                <span className="text-xs uppercase tracking-wide text-slate-500">Qty authorized</span>
                <Input
                  type="number"
                  min={0}
                  step="any"
                  value={line.quantityAuthorized}
                  onChange={(event) =>
                    updateLine(index, {
                      quantityAuthorized: event.target.value === '' ? '' : Number(event.target.value),
                    })
                  }
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs uppercase tracking-wide text-slate-500">Reason code</span>
                <Input
                  value={line.reasonCode || ''}
                  onChange={(event) => updateLine(index, { reasonCode: event.target.value })}
                />
              </label>
              <label className="block space-y-1 md:col-span-2 xl:col-span-5">
                <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
                <Textarea
                  value={line.notes || ''}
                  onChange={(event) => updateLine(index, { notes: event.target.value })}
                />
              </label>
              {lines.length > 1 ? (
                <div className="flex items-end justify-end">
                  <Button variant="secondary" size="sm" onClick={() => removeLine(index)}>
                    Remove line
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-between gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setLines((current) => [
                ...current,
                { lineNumber: current.length + 1, itemId: '', uom: '', quantityAuthorized: '' },
              ])
            }
          >
            Add line
          </Button>
          <Button onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? 'Creating return...' : 'Create return authorization'}
          </Button>
        </div>
      </Panel>
    </div>
  )
}
