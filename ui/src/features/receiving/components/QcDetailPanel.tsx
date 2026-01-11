import { memo } from 'react'
import type { PurchaseOrderReceiptLine, QcEvent } from '@api/types'
import { Alert, Badge, Button, Input, LoadingSpinner, Textarea } from '@shared/ui'
import { formatDate } from '@shared/formatters'
import { KeyboardHint } from './KeyboardHint'
import { getQcStatus } from '../utils'

type Props = {
  line: PurchaseOrderReceiptLine
  qcStats: { accept: number; hold: number; reject: number; remaining: number }
  qcRemaining: number
  qcEventType: 'accept' | 'hold' | 'reject'
  qcQuantity: number | ''
  qcReasonCode: string
  qcNotes: string
  qcQuantityInvalid: boolean
  canRecordQc: boolean
  qcEvents: QcEvent[]
  qcEventsLoading: boolean
  qcEventsError: boolean
  lastEvent?: QcEvent | null
  mutationErrorMessage?: string
  mutationPending: boolean
  onEventTypeChange: (eventType: 'accept' | 'hold' | 'reject') => void
  onQuantityChange: (value: number | '') => void
  onReasonCodeChange: (value: string) => void
  onNotesChange: (value: string) => void
  onRecord: () => void
  putawayAvailable: number
  putawayBlockedReason?: string | null
}

export function QcDetailPanel({
  line,
  qcStats,
  qcRemaining,
  qcEventType,
  qcQuantity,
  qcReasonCode,
  qcNotes,
  qcQuantityInvalid,
  canRecordQc,
  qcEvents,
  qcEventsLoading,
  qcEventsError,
  lastEvent,
  mutationErrorMessage,
  mutationPending,
  onEventTypeChange,
  onQuantityChange,
  onReasonCodeChange,
  onNotesChange,
  onRecord,
  putawayAvailable,
  putawayBlockedReason,
}: Props) {
  const status = getQcStatus(line)

  return (
    <div className="rounded-lg border border-slate-200 p-3 space-y-3">
      {mutationErrorMessage && (
        <Alert variant="error" title="QC event not recorded" message={mutationErrorMessage} />
      )}
      {mutationPending && (
        <Alert variant="info" title="Recording QC event" message="Updating QC totals and putaway eligibility." />
      )}
      {lastEvent && (
        <Alert
          variant="success"
          title="QC event recorded"
          message={`${
            lastEvent.eventType === 'accept'
              ? 'Accepted'
              : lastEvent.eventType === 'hold'
                ? 'Held'
                : 'Rejected'
          } ${lastEvent.quantity} ${lastEvent.uom}.`}
        />
      )}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-800">QC line detail</div>
          <div className="text-xs text-slate-600">
            {line.itemSku ?? line.itemId ?? 'Item'}
            {line.itemName ? ` - ${line.itemName}` : ''}
          </div>
          <div className="text-xs text-slate-500">Receipt line {line.id.slice(0, 8)}...</div>
        </div>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>
      <div className="grid gap-2 md:grid-cols-5 text-sm text-slate-700">
        <div>
          Received: {line.quantityReceived} {line.uom}
        </div>
        <div>Accepted: {qcStats.accept}</div>
        <div>On hold: {qcStats.hold}</div>
        <div>Rejected: {qcStats.reject}</div>
        <div>Remaining: {qcStats.remaining}</div>
      </div>

      {/* Quick actions for common case */}
      {qcRemaining > 0 && (
        <div className="rounded-lg bg-green-50 border border-green-200 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-green-900">Quick Accept</div>
              <div className="text-xs text-green-700">Accept all remaining quantity ({qcRemaining} {line.uom})</div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="primary"
              onClick={() => {
                onEventTypeChange('accept')
                onQuantityChange(qcRemaining)
                // Auto-submit after short delay to allow user to see the change
                setTimeout(() => {
                  if (qcRemaining > 0) onRecord()
                }, 100)
              }}
              disabled={qcRemaining <= 0 || mutationPending}
            >
              Accept All <KeyboardHint shortcut="A" />
            </Button>
          </div>
        </div>
      )}

      {/* Detailed classification for exceptions */}
      <details className="group" open={qcEventType !== 'accept' || (qcQuantity !== '' && qcQuantity !== qcRemaining)}>
        <summary className="cursor-pointer text-xs uppercase tracking-wide text-slate-500 hover:text-slate-700 select-none">
          <span className="inline-flex items-center gap-1">
            Partial or exception classification
            <svg className="w-4 h-4 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </span>
        </summary>
        <div className="mt-3 space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">Classify as</div>
          <div className="mt-1 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={qcEventType === 'accept' ? 'primary' : 'secondary'}
              onClick={() => onEventTypeChange('accept')}
              disabled={qcRemaining <= 0}
            >
              Accept
            </Button>
            <Button
              type="button"
              size="sm"
              variant={qcEventType === 'hold' ? 'primary' : 'secondary'}
              onClick={() => onEventTypeChange('hold')}
              disabled={qcRemaining <= 0}
            >
              Hold
            </Button>
            <Button
              type="button"
              size="sm"
              variant={qcEventType === 'reject' ? 'primary' : 'secondary'}
              onClick={() => onEventTypeChange('reject')}
              disabled={qcRemaining <= 0}
            >
              Reject
            </Button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Accept makes quantity available for putaway. Hold blocks putaway. Reject removes from usable stock.
          </p>
          {qcRemaining <= 0 && (
            <p className="mt-2 text-xs text-slate-500">
              QC is complete for this line. There is no remaining quantity to classify.
            </p>
          )}
        </div>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Quantity (max {qcRemaining})</span>
          <Input
            type="number"
            min={0}
            max={qcRemaining}
            value={qcQuantity}
            onChange={(e) => onQuantityChange(e.target.value === '' ? '' : Number(e.target.value))}
            disabled={qcRemaining <= 0}
          />
          {qcQuantityInvalid && qcRemaining > 0 && (
            <div className="text-xs text-amber-700">Enter a quantity between 1 and {qcRemaining}.</div>
          )}
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
          <Input value={line.uom} disabled />
        </label>
      </div>
      {qcEventType !== 'accept' && (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Reason code (optional)</span>
            <Input value={qcReasonCode} onChange={(e) => onReasonCodeChange(e.target.value)} placeholder="Optional reason" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Notes (optional)</span>
            <Textarea value={qcNotes} onChange={(e) => onNotesChange(e.target.value)} placeholder="Notes for hold/reject" />
          </label>
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-slate-500">
          Putaway:{' '}
          {qcStats.accept > 0
            ? `Available ${putawayAvailable} ${line.uom}`
            : 'Blocked until some quantity is accepted.'}
          {putawayBlockedReason ? ` (${putawayBlockedReason})` : ''}
        </div>
        <Button type="button" size="sm" disabled={!canRecordQc} onClick={onRecord}>
          {mutationPending ? 'Recording...' : 'Record QC'}
        </Button>
      </div>
        </div>
      </details>
      <div className="border-t border-slate-200 pt-3">
        <div className="text-xs uppercase tracking-wide text-slate-500">QC events</div>
        {qcEventsLoading && <LoadingSpinner label="Loading QC events..." />}
        {qcEventsError && <div className="text-xs text-amber-700">Unable to load QC events. Try again.</div>}
        {!qcEventsLoading && !qcEventsError && qcEvents.length === 0 && (
          <div className="text-xs text-slate-500">No QC events recorded yet.</div>
        )}
        {!qcEventsLoading && !qcEventsError && qcEvents.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-slate-600">
            {qcEvents.map((event) => {
              const actorLabel =
                event.actorType === 'system'
                  ? 'System'
                  : event.actorId
                    ? `User ${event.actorId.slice(0, 8)}`
                    : 'User'
              const occurredLabel = formatDate(event.occurredAt)
              return (
                <li key={event.id}>
                  {event.eventType.toUpperCase()} {event.quantity} {event.uom}
                  {event.reasonCode ? ` - ${event.reasonCode}` : ''}
                  {event.notes ? ` (${event.notes})` : ''}
                  {occurredLabel ? ` · ${occurredLabel}` : ''}
                  {actorLabel ? ` · ${actorLabel}` : ''}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

// Memoize to prevent unnecessary re-renders when parent updates
export default memo(QcDetailPanel)
