import { useNavigate, useParams } from 'react-router-dom'
import { useQcEvent } from '../queries'
import type { ApiError } from '@api/types'
import { Alert, Button, Card, LoadingSpinner, Section } from '@shared/ui'
import { formatDate } from '@shared/formatters'

export default function QcEventDetailPage() {
  const { qcEventId } = useParams<{ qcEventId: string }>()
  const navigate = useNavigate()
  const qcEventQuery = useQcEvent(qcEventId)

  if (qcEventQuery.isLoading) {
    return (
      <Section title="QC Event">
        <Card>
          <LoadingSpinner label="Loading QC event..." />
        </Card>
      </Section>
    )
  }

  if (qcEventQuery.isError || !qcEventQuery.data) {
    return (
      <Section title="QC Event">
        <Card>
          <Alert
            variant="error"
            title="QC event unavailable"
            message={(qcEventQuery.error as ApiError)?.message ?? 'QC event not found.'}
          />
        </Card>
      </Section>
    )
  }

  const event = qcEventQuery.data

  return (
    <Section title="QC Event">
      <Card>
        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-700">
            <div className="font-semibold">Event {event.id}</div>
            <div className="text-xs text-slate-500">Receipt line {event.purchaseOrderReceiptLineId}</div>
          </div>
          <Button variant="secondary" size="sm" onClick={() => navigate(-1)}>
            Back
          </Button>
        </div>
        <div className="mt-4 grid gap-3 text-sm text-slate-700 md:grid-cols-2">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Type</div>
            <div className="font-semibold">{event.eventType}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Quantity</div>
            <div className="font-semibold">
              {event.quantity} {event.uom}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Occurred</div>
            <div className="font-semibold">{formatDate(event.occurredAt)}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Actor</div>
            <div className="font-semibold">
              {event.actorType}:{event.actorId ?? '—'}
            </div>
          </div>
          {event.reasonCode && (
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Reason</div>
              <div className="font-semibold">{event.reasonCode}</div>
            </div>
          )}
          {event.notes && (
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Notes</div>
              <div className="font-semibold">{event.notes}</div>
            </div>
          )}
        </div>
      </Card>
    </Section>
  )
}
