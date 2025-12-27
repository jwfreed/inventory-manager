import type { ReceiptLineInput, ReceiptLineSummary } from '../types'
import { Alert } from '../../../components/Alert'

type Props = {
  summary: ReceiptLineSummary
  totalLines: number
  discrepancyLabels: Record<ReceiptLineInput['discrepancyReason'], string>
}

export function ReceiptSummaryPanel({ summary, totalLines, discrepancyLabels }: Props) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-sm font-semibold text-slate-800">Step 3: Review summary</div>
      <div className="mt-2 grid gap-2 md:grid-cols-3 text-sm text-slate-700">
        <div>
          Lines received: {summary.receivedLines.length} / {totalLines}
        </div>
        <div>Lines remaining: {summary.remainingLines.length}</div>
        <div>Discrepancies: {summary.discrepancyLines.length}</div>
      </div>
      <div className="mt-2 text-xs text-slate-500">
        Total expected {summary.totalExpected} · Total received {summary.totalReceived}
      </div>
      {summary.discrepancyLines.length > 0 && (
        <div className="mt-2 text-xs text-slate-600">
          <div className="font-semibold text-slate-700">Discrepancies</div>
          <ul className="mt-1 list-disc pl-4">
            {summary.discrepancyLines.map((line) => {
              const deltaLabel = line.delta > 0 ? `over by ${line.delta}` : `short by ${Math.abs(line.delta)}`
              const reason = line.discrepancyReason
                ? discrepancyLabels[line.discrepancyReason]
                : 'Reason required'
              const note = line.discrepancyNotes ? ` — ${line.discrepancyNotes}` : ''
              return (
                <li key={line.purchaseOrderLineId}>
                  {line.itemLabel}: expected {line.expectedQty} {line.uom}, received {line.receivedQty}{' '}
                  {line.uom} ({deltaLabel}) · {reason}
                  {note}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {summary.receivedLines.length === 0 && (
        <div className="mt-2">
          <Alert
            variant="warning"
            title="No received quantities"
            message="Enter at least one received quantity to post a receipt."
          />
        </div>
      )}
      {summary.missingReasons.length > 0 && (
        <div className="mt-2">
          <Alert
            variant="warning"
            title="Discrepancy reason required"
            message={`Select a reason for ${summary.missingReasons.length} line(s) with a variance.`}
          />
        </div>
      )}
      <p className="mt-2 text-xs text-slate-500">
        Posting creates a receipt, updates inventory immediately, and locks this record.
      </p>
      <p className="mt-1 text-xs text-slate-500">
        Discrepancies are recorded in the receipt notes for auditability.
      </p>
    </div>
  )
}
