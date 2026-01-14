import { Link, useParams } from 'react-router-dom'
import type { PurchaseOrderReceipt } from '@api/types'
import { formatDate } from '@shared/formatters'
import { Alert, Badge, Button, LoadingSpinner, Section } from '@shared/ui'
import { ReceiptDocument } from '../components/ReceiptDocument'
import { useReceipt } from '../queries'

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  posted: 'Posted',
  pending_qc: 'Pending QC',
  qc_passed: 'QC Passed',
  qc_failed: 'QC Failed',
  putaway_pending: 'Putaway Pending',
  complete: 'Complete',
  voided: 'Voided',
}

const STATUS_VARIANTS: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  draft: 'neutral',
  posted: 'neutral',
  pending_qc: 'warning',
  qc_passed: 'info',
  qc_failed: 'danger',
  putaway_pending: 'warning',
  complete: 'success',
  voided: 'danger',
}

function resolveWorkflowStatus(receipt: PurchaseOrderReceipt) {
  return receipt.workflowStatus || receipt.status || 'posted'
}

export default function ReceiptDetailPage() {
  const { receiptId } = useParams<{ receiptId: string }>()
  const resolvedReceiptId = receiptId ?? ''
  const receiptQuery = useReceipt(resolvedReceiptId)

  if (!resolvedReceiptId) {
    return <Alert variant="error" title="Receipt not found" message="Missing receipt id." />
  }

  if (receiptQuery.isLoading) {
    return <LoadingSpinner label="Loading receipt..." />
  }

  if (receiptQuery.isError || !receiptQuery.data) {
    return <Alert variant="error" title="Receipt not found" message="This receipt could not be loaded." />
  }

  const receipt = receiptQuery.data
  const workflow = resolveWorkflowStatus(receipt)
  const qcEligible = receipt.qcEligible ?? workflow === 'pending_qc'
  const putawayEligible =
    receipt.putawayEligible ?? (workflow === 'qc_passed' || workflow === 'putaway_pending')
  const putawayLink = receipt.draftPutawayId
    ? `/receiving/putaway?receiptId=${receipt.id}&putawayId=${receipt.draftPutawayId}`
    : `/receiving/putaway?receiptId=${receipt.id}`

  return (
    <div className="space-y-6">
      <Section title="Receipt Detail" description="Read-only receipt record with QC and putaway navigation.">
        <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-slate-200 bg-white p-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-700">Receipt</span>
              <span className="font-mono text-sm text-slate-900">{receipt.id}</span>
              <Badge variant={STATUS_VARIANTS[workflow] || 'neutral'}>{STATUS_LABELS[workflow] || workflow}</Badge>
            </div>
            <div className="text-sm text-slate-600">
              PO: {receipt.purchaseOrderNumber || receipt.purchaseOrderId}
            </div>
            <div className="text-sm text-slate-600">
              Vendor: {receipt.vendorName || receipt.vendorCode || 'N/A'}
            </div>
            <div className="text-xs text-slate-500">Received {formatDate(receipt.receivedAt)}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            {qcEligible && (
              <Link to={`/qc/receipts/${receipt.id}`}>
                <Button size="sm">Start QC</Button>
              </Link>
            )}
            {putawayEligible && (
              <Link to={putawayLink}>
                <Button size="sm" variant="secondary">
                  Start Putaway
                </Button>
              </Link>
            )}
          </div>
        </div>

        <ReceiptDocument receipt={receipt} showQcStatus={true} />
      </Section>
    </div>
  )
}
