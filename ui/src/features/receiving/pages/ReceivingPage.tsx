import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { PurchaseOrder, PurchaseOrderReceipt } from '@api/types'
import { usePurchaseOrdersList } from '@features/purchaseOrders/queries'
import { Alert, Badge, Button, Card, DataTable, LoadingSpinner, Section } from '@shared/ui'
import { formatDate, formatNumber } from '@shared/formatters'
import { useReceiptsList } from '../queries'

type QueueStage =
  | 'awaiting_receipt'
  | 'qc_pending'
  | 'qc_in_progress'
  | 'putaway_ready'
  | 'putaway_in_progress'
  | 'complete'

type QueueRow = {
  id: string
  poNumber: string
  receiptLabel: string | null
  supplier: string
  dateLabel: string
  stage: QueueStage
  stageLabel: string
  progress: string
  actionLabel: string
  actionPath: string | null
  completed: boolean
}

const STAGE_VARIANTS: Record<QueueStage, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  awaiting_receipt: 'warning',
  qc_pending: 'warning',
  qc_in_progress: 'info',
  putaway_ready: 'info',
  putaway_in_progress: 'warning',
  complete: 'success',
}

const formatReceiptLabel = (receipt: PurchaseOrderReceipt) => {
  if (receipt.receiptNumber) return `Receipt ${receipt.receiptNumber}`
  if (receipt.externalRef) return `Receipt ${receipt.externalRef}`
  return 'Receipt posted'
}

const sumReceiptLines = (receipt: PurchaseOrderReceipt, read: (line: NonNullable<PurchaseOrderReceipt['lines']>[number]) => number) =>
  (receipt.lines ?? []).reduce((sum, line) => sum + read(line), 0)

const resolveReceivedQuantity = (receipt: PurchaseOrderReceipt) =>
  receipt.totalReceived ?? sumReceiptLines(receipt, (line) => line.quantityReceived ?? 0)

const resolveAcceptedQuantity = (receipt: PurchaseOrderReceipt) =>
  receipt.totalAccepted ?? sumReceiptLines(receipt, (line) => line.qcSummary?.breakdown.accept ?? 0)

const resolveHoldQuantity = (receipt: PurchaseOrderReceipt) =>
  receipt.totalHold ?? sumReceiptLines(receipt, (line) => line.qcSummary?.breakdown.hold ?? 0)

const resolveQcRemaining = (receipt: PurchaseOrderReceipt) =>
  receipt.qcRemaining ?? sumReceiptLines(receipt, (line) => line.qcSummary?.remainingUninspectedQuantity ?? line.quantityReceived ?? 0)

const resolvePutawayRemaining = (receipt: PurchaseOrderReceipt) => {
  if (receipt.putawayStatus === 'complete' || receipt.workflowStatus === 'complete') return 0
  if (receipt.putawayPending !== undefined) return receipt.putawayPending
  return sumReceiptLines(receipt, (line) => line.availableForNewPutaway ?? line.remainingQuantityToPutaway ?? 0)
}

const formatQuantityGroups = (receipt: PurchaseOrderReceipt, read: (line: NonNullable<PurchaseOrderReceipt['lines']>[number]) => number) => {
  const lines = receipt.lines ?? []
  if (lines.length === 0) return null
  const groups = new Map<string, number>()
  lines.forEach((line) => {
    const uom = line.uom || 'units'
    groups.set(uom, (groups.get(uom) ?? 0) + read(line))
  })
  return [...groups.entries()]
    .filter(([, quantity]) => quantity > 0)
    .map(([uom, quantity]) => `${formatNumber(quantity)} ${uom}`)
    .join(' + ')
}

const formatExpectedPoProgress = (po: PurchaseOrder) => {
  const lineCount = po.lines?.length ?? 0
  if (lineCount === 0) return 'No receipt lines loaded'
  return `${formatNumber(lineCount)} ${lineCount === 1 ? 'line' : 'lines'} expected`
}

const buildReceiptRow = (receipt: PurchaseOrderReceipt): QueueRow => {
  const qcRemaining = resolveQcRemaining(receipt)
  const accepted = resolveAcceptedQuantity(receipt)
  const hold = resolveHoldQuantity(receipt)
  const putawayRemaining = resolvePutawayRemaining(receipt)
  const received = resolveReceivedQuantity(receipt)
  const receivedSummary = formatQuantityGroups(receipt, (line) => line.quantityReceived ?? 0)
  const acceptedSummary = formatQuantityGroups(receipt, (line) => line.qcSummary?.breakdown.accept ?? 0)
  const workflowStatus = receipt.workflowStatus ?? receipt.status ?? 'posted'
  const complete = workflowStatus === 'complete' || receipt.putawayStatus === 'complete'
  const putawayInProgress =
    !complete &&
    (Boolean(receipt.draftPutawayId) ||
      receipt.putawayStatus === 'pending' ||
      Boolean(receipt.hasPutaway && putawayRemaining > 0))

  if (complete) {
    return {
      id: `receipt-${receipt.id}`,
      poNumber: receipt.purchaseOrderNumber || 'PO unavailable',
      receiptLabel: formatReceiptLabel(receipt),
      supplier: receipt.vendorName || receipt.vendorCode || 'Supplier unavailable',
      dateLabel: receipt.receivedAt ? `Received ${formatDate(receipt.receivedAt)}` : 'Received date unavailable',
      stage: 'complete',
      stageLabel: 'Inbound complete',
      progress: 'Putaway complete',
      actionLabel: 'View receipt',
      actionPath: `/receipts/${receipt.id}`,
      completed: true,
    }
  }

  if (qcRemaining > 0) {
    const started = accepted > 0 || hold > 0 || (receipt.totalReject ?? 0) > 0
    return {
      id: `receipt-${receipt.id}`,
      poNumber: receipt.purchaseOrderNumber || 'PO unavailable',
      receiptLabel: formatReceiptLabel(receipt),
      supplier: receipt.vendorName || receipt.vendorCode || 'Supplier unavailable',
      dateLabel: receipt.receivedAt ? `Received ${formatDate(receipt.receivedAt)}` : 'Received date unavailable',
      stage: started ? 'qc_in_progress' : 'qc_pending',
      stageLabel: started ? 'QC in progress' : 'QC pending',
      progress: `${receivedSummary || `${formatNumber(received)} units`} received · ${formatNumber(accepted)} accepted`,
      actionLabel: 'Continue QC',
      actionPath: `/qc/receipts/${receipt.id}`,
      completed: false,
    }
  }

  if (accepted > 0 && putawayInProgress) {
    return {
      id: `receipt-${receipt.id}`,
      poNumber: receipt.purchaseOrderNumber || 'PO unavailable',
      receiptLabel: formatReceiptLabel(receipt),
      supplier: receipt.vendorName || receipt.vendorCode || 'Supplier unavailable',
      dateLabel: receipt.receivedAt ? `Received ${formatDate(receipt.receivedAt)}` : 'Received date unavailable',
      stage: 'putaway_in_progress',
      stageLabel: 'Putaway in progress',
      progress: `${acceptedSummary || `${formatNumber(accepted)} units`} accepted · putaway draft open`,
      actionLabel: 'Continue putaway',
      actionPath: receipt.draftPutawayId
        ? `/receiving/putaway?receiptId=${receipt.id}&putawayId=${receipt.draftPutawayId}`
        : `/receiving/putaway?receiptId=${receipt.id}`,
      completed: false,
    }
  }

  if (accepted > 0 && hold <= 0) {
    return {
      id: `receipt-${receipt.id}`,
      poNumber: receipt.purchaseOrderNumber || 'PO unavailable',
      receiptLabel: formatReceiptLabel(receipt),
      supplier: receipt.vendorName || receipt.vendorCode || 'Supplier unavailable',
      dateLabel: receipt.receivedAt ? `Received ${formatDate(receipt.receivedAt)}` : 'Received date unavailable',
      stage: 'putaway_ready',
      stageLabel: 'Putaway ready',
      progress: `${acceptedSummary || `${formatNumber(accepted)} units`} accepted`,
      actionLabel: 'Plan putaway',
      actionPath: `/receiving/putaway?receiptId=${receipt.id}`,
      completed: false,
    }
  }

  return {
    id: `receipt-${receipt.id}`,
    poNumber: receipt.purchaseOrderNumber || 'PO unavailable',
    receiptLabel: formatReceiptLabel(receipt),
    supplier: receipt.vendorName || receipt.vendorCode || 'Supplier unavailable',
    dateLabel: receipt.receivedAt ? `Received ${formatDate(receipt.receivedAt)}` : 'Received date unavailable',
    stage: 'qc_in_progress',
    stageLabel: hold > 0 ? 'QC in progress' : 'QC accepted',
    progress: hold > 0
      ? `${formatNumber(hold)} held · resolve hold before putaway`
      : 'No accepted quantity available for putaway',
    actionLabel: 'Continue QC',
    actionPath: `/qc/receipts/${receipt.id}`,
    completed: false,
  }
}

const buildPoRow = (po: PurchaseOrder): QueueRow => ({
  id: `po-${po.id}`,
  poNumber: po.poNumber || 'PO unavailable',
  receiptLabel: null,
  supplier: po.vendorName || po.vendorCode || 'Supplier unavailable',
  dateLabel: po.expectedDate ? `Expected ${formatDate(po.expectedDate)}` : 'Expected date unavailable',
  stage: 'awaiting_receipt',
  stageLabel: 'Awaiting receipt',
  progress: formatExpectedPoProgress(po),
  actionLabel: 'Receive goods',
  actionPath: `/receiving/receipt?poId=${po.id}`,
  completed: false,
})

export default function ReceivingPage() {
  const navigate = useNavigate()
  const [showCompleted, setShowCompleted] = useState(false)

  const poListQuery = usePurchaseOrdersList({ limit: 200 }, { staleTime: 60_000 })
  const receiptsQuery = useReceiptsList({ limit: 200, includeLines: true }, { staleTime: 30_000 })

  const rows = useMemo(() => {
    const receipts = receiptsQuery.data?.data ?? []
    const activeReceiptPoIds = new Set(
      receipts
        .filter((receipt) => receipt.status !== 'voided')
        .map((receipt) => receipt.purchaseOrderId),
    )
    const awaitingReceiptRows = (poListQuery.data?.data ?? [])
      .filter((po) => po.status?.toLowerCase() === 'approved')
      .filter((po) => !activeReceiptPoIds.has(po.id))
      .map(buildPoRow)
    const receiptRows = receipts
      .filter((receipt) => receipt.status !== 'voided')
      .map(buildReceiptRow)

    return [...awaitingReceiptRows, ...receiptRows].sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1
      return a.stage.localeCompare(b.stage)
    })
  }, [poListQuery.data, receiptsQuery.data])

  const visibleRows = showCompleted ? rows : rows.filter((row) => !row.completed)
  const readyToReceive = rows.filter((row) => row.stage === 'awaiting_receipt').length
  const needsQc = rows.filter((row) => row.stage === 'qc_pending' || row.stage === 'qc_in_progress').length
  const readyForPutaway = rows.filter((row) => row.stage === 'putaway_ready' || row.stage === 'putaway_in_progress').length
  const completedToday = rows.filter((row) => row.completed && row.dateLabel.includes(formatDate(new Date()))).length
  const isLoading = poListQuery.isLoading || receiptsQuery.isLoading
  const isError = poListQuery.isError || receiptsQuery.isError

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-slate-900">Receiving & QC</h2>
        <p className="mt-1 text-sm text-slate-600">
          Track inbound orders from receipt through QC and putaway.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        {[
          { label: 'Ready to receive', value: readyToReceive },
          { label: 'Needs QC', value: needsQc },
          { label: 'Ready for putaway', value: readyForPutaway },
          { label: 'Completed today', value: completedToday },
        ].map((metric) => (
          <Card key={metric.label}>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{metric.label}</div>
            <div className="mt-2 text-2xl font-bold text-slate-900">{formatNumber(metric.value)}</div>
          </Card>
        ))}
      </div>

      <Section
        title="Inbound work"
        description="Approved POs and posted receipts that still need receipt capture, QC, or putaway."
        action={
          <Button type="button" variant="secondary" size="sm" onClick={() => setShowCompleted((value) => !value)}>
            {showCompleted ? 'Hide completed' : 'Show completed'}
          </Button>
        }
      >
        {isError && (
          <Alert
            variant="error"
            title="Failed to load inbound work"
            message="Try refreshing the page."
          />
        )}

        {isLoading ? (
          <LoadingSpinner label="Loading inbound work..." />
        ) : (
          <Card>
            <DataTable
              rows={visibleRows}
              rowKey={(row) => row.id}
              emptyMessage={
                showCompleted
                  ? 'No inbound work found.'
                  : 'No open inbound work. Use Show completed to review completed receipts.'
              }
              columns={[
                {
                  id: 'po-receipt',
                  header: 'PO / Receipt',
                  cell: (row) => (
                    <div>
                      <div className="font-medium text-slate-900">{row.receiptLabel ?? row.poNumber}</div>
                      {row.receiptLabel && (
                        <div className="text-xs text-slate-500">{row.poNumber}</div>
                      )}
                    </div>
                  ),
                },
                {
                  id: 'supplier',
                  header: 'Supplier',
                  cell: (row) => row.supplier,
                  truncate: true,
                },
                {
                  id: 'date',
                  header: 'Date',
                  cell: (row) => row.dateLabel,
                },
                {
                  id: 'stage',
                  header: 'Stage',
                  cell: (row) => <Badge variant={STAGE_VARIANTS[row.stage]}>{row.stageLabel}</Badge>,
                },
                {
                  id: 'progress',
                  header: 'Progress',
                  cell: (row) => row.progress,
                  truncate: true,
                },
              ]}
              rowActions={(row) =>
                row.actionPath ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={row.completed ? 'secondary' : 'primary'}
                    onClick={() => navigate(row.actionPath as string)}
                  >
                    {row.actionLabel}
                  </Button>
                ) : (
                  <span className="text-xs text-slate-500">No action available</span>
                )
              }
            />
          </Card>
        )}
      </Section>
    </div>
  )
}
