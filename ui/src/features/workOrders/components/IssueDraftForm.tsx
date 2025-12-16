import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { Input, Textarea } from '../../../components/Inputs'
import { LoadingSpinner } from '../../../components/Loading'
import {
  createWorkOrderIssue,
  postWorkOrderIssue,
  type IssueDraftPayload,
} from '../../../api/endpoints/workOrders'
import type { ApiError, WorkOrderIssue, WorkOrder } from '../../../api/types'
import { PostConfirmModal } from './PostConfirmModal'
import { formatNumber } from '../../../lib/formatters'

type Line = {
  componentItemId: string
  fromLocationId: string
  uom: string
  quantityIssued: number | ''
  notes?: string
}

type Props = {
  workOrder: WorkOrder
  onRefetch: () => void
}

export function IssueDraftForm({ workOrder, onRefetch }: Props) {
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 16))
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([
    { componentItemId: '', fromLocationId: '', uom: workOrder.outputUom, quantityIssued: '' },
  ])
  const [createdIssue, setCreatedIssue] = useState<WorkOrderIssue | null>(null)
  const [showPostConfirm, setShowPostConfirm] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)

  const issueMutation = useMutation<WorkOrderIssue, ApiError, IssueDraftPayload>({
    mutationFn: (payload) => createWorkOrderIssue(workOrder.id, payload),
    onSuccess: (issue) => {
      setCreatedIssue(issue)
      setWarning(null)
      void onRefetch()
    },
  })

  const postMutation = useMutation<WorkOrderIssue, ApiError, { issueId: string }>({
    mutationFn: ({ issueId }) => postWorkOrderIssue(workOrder.id, issueId),
    onSuccess: (issue) => {
      setCreatedIssue(issue)
      setShowPostConfirm(false)
      void onRefetch()
    },
  })

  const addLine = () =>
    setLines((prev) => [...prev, { componentItemId: '', fromLocationId: '', uom: workOrder.outputUom, quantityIssued: '' }])

  const updateLine = (index: number, patch: Partial<Line>) => {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)))
  }

  const removeLine = (index: number) => {
    setLines((prev) => prev.filter((_, i) => i !== index))
  }

  const validate = (): string | null => {
    if (lines.length === 0) return 'Add at least one line.'
    for (const line of lines) {
      if (!line.componentItemId || !line.fromLocationId || !line.uom || line.quantityIssued === '') {
        return 'All line fields are required.'
      }
      if (Number(line.quantityIssued) <= 0) return 'Quantities must be greater than zero.'
    }
    return null
  }

  const totalIssued = useMemo(
    () =>
      lines.reduce((sum, line) => sum + (Number(line.quantityIssued) || 0), 0),
    [lines],
  )

  const onSubmitDraft = () => {
    const validation = validate()
    if (validation) {
      setWarning(validation)
      return
    }
    setWarning(null)
    issueMutation.mutate({
      occurredAt: new Date(occurredAt).toISOString(),
      notes: notes || undefined,
      lines: lines.map((line, idx) => ({
        lineNumber: idx + 1,
        componentItemId: line.componentItemId,
        fromLocationId: line.fromLocationId,
        uom: line.uom,
        quantityIssued: Number(line.quantityIssued),
        notes: line.notes,
      })),
    })
  }

  const onConfirmPost = () => {
    if (!createdIssue) return
    postMutation.mutate({ issueId: createdIssue.id })
  }

  const isPosted = createdIssue?.status === 'posted'

  return (
    <Card title="Create material issue" description="Draft first, then post to create inventory movement.">
      {issueMutation.isPending && <LoadingSpinner label="Creating issue..." />}
      {postMutation.isPending && <LoadingSpinner label="Posting issue..." />}
      {warning && <Alert variant="warning" title="Fix validation" message={warning} />}
      {issueMutation.isError && (
        <Alert
          variant="error"
          title="Create failed"
          message={issueMutation.error.message}
        />
      )}
      {postMutation.isError && (
        <Alert variant="error" title="Post failed" message={postMutation.error.message} />
      )}
      {createdIssue && (
        <Alert
          variant={isPosted ? 'success' : 'info'}
          title={isPosted ? 'Issue posted' : 'Issue draft created'}
          message={`Issue ID: ${createdIssue.id}`}
        />
      )}

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Occurred at
          </span>
          <Input
            type="datetime-local"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</span>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional notes"
          />
        </label>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">Lines</div>
          <Button variant="secondary" size="sm" onClick={addLine}>
            Add line
          </Button>
        </div>
        {lines.map((line, idx) => (
          <div
            key={idx}
            className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-5"
          >
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Component Item ID</span>
              <Input
                value={line.componentItemId}
                onChange={(e) => updateLine(idx, { componentItemId: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">From Location ID</span>
              <Input
                value={line.fromLocationId}
                onChange={(e) => updateLine(idx, { fromLocationId: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
              <Input value={line.uom} onChange={(e) => updateLine(idx, { uom: e.target.value })} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Quantity</span>
              <Input
                type="number"
                min={0}
                value={line.quantityIssued}
                onChange={(e) =>
                  updateLine(idx, {
                    quantityIssued: e.target.value === '' ? '' : Number(e.target.value),
                  })
                }
              />
            </label>
            <div className="flex items-start gap-2">
              <label className="flex-1 space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
                <Textarea
                  value={line.notes || ''}
                  onChange={(e) => updateLine(idx, { notes: e.target.value })}
                />
              </label>
              {lines.length > 1 && (
                <Button variant="secondary" size="sm" onClick={() => removeLine(idx)}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-700">
          Total to issue:{' '}
          <span className="font-semibold text-red-600">-{formatNumber(totalIssued)}</span>{' '}
          {lines[0]?.uom || ''}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onSubmitDraft} disabled={issueMutation.isPending}>
            Save draft
          </Button>
          <Button
            size="sm"
            onClick={() => setShowPostConfirm(true)}
            disabled={!createdIssue || isPosted || postMutation.isPending}
          >
            Post issue
          </Button>
        </div>
      </div>

      <PostConfirmModal
        isOpen={showPostConfirm}
        onCancel={() => setShowPostConfirm(false)}
        onConfirm={onConfirmPost}
        title="Post Issue?"
        body="This will create exactly 1 inventory movement (type: issue) with negative deltas for the lines below. Drafts do not affect inventory until posted."
        preview={
          <div className="space-y-1 text-sm text-slate-800">
            {createdIssue?.lines.map((line) => (
              <div key={line.id} className="flex justify-between">
                <span>
                  {line.componentItemId} @ {line.fromLocationId}
                </span>
                <span className="text-red-600">
                  -{formatNumber(line.quantityIssued)} {line.uom}
                </span>
              </div>
            ))}
          </div>
        }
      />
    </Card>
  )
}
