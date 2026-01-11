import { Badge, Button, Card } from '@shared/ui'
import { formatDate, formatNumber } from '@shared/formatters'
import type { PurchaseOrderReceipt } from '@api/types'

type QueuedReceipt = {
  receipt: PurchaseOrderReceipt
  totalLines: number
  totalQuantity: number
  qcProgress: {
    complete: number
    inProgress: number
    pending: number
  }
}

type Props = {
  receipts: PurchaseOrderReceipt[]
  activeReceiptId?: string
  onSelectReceipt: (receiptId: string) => void
  isLoading?: boolean
}

function calculateQcProgress(receipt: PurchaseOrderReceipt) {
  const lines = receipt.lines || []
  const totalLines = lines.length
  const totalQuantity = lines.reduce((sum, line) => sum + line.quantityReceived, 0)

  let complete = 0
  let inProgress = 0
  let pending = 0

  lines.forEach((line) => {
    if (!line.qcSummary) {
      pending++
    } else if (line.qcSummary.remainingUninspectedQuantity === 0) {
      complete++
    } else if (line.qcSummary.totalQcQuantity > 0) {
      inProgress++
    } else {
      pending++
    }
  })

  return { totalLines, totalQuantity, qcProgress: { complete, inProgress, pending } }
}

export function QcBatchQueue({ receipts, activeReceiptId, onSelectReceipt, isLoading }: Props) {
  const queuedReceipts: QueuedReceipt[] = receipts.map((receipt) => ({
    receipt,
    ...calculateQcProgress(receipt),
  }))

  // Sort: pending first, then in-progress, then complete
  const sortedReceipts = [...queuedReceipts].sort((a, b) => {
    const aScore = a.qcProgress.pending * 3 + a.qcProgress.inProgress * 2 + a.qcProgress.complete
    const bScore = b.qcProgress.pending * 3 + b.qcProgress.inProgress * 2 + b.qcProgress.complete
    return bScore - aScore
  })

  const totalInQueue = sortedReceipts.length
  const completedCount = sortedReceipts.filter(
    (r) => r.qcProgress.complete === r.totalLines
  ).length
  const needsAttention = totalInQueue - completedCount

  return (
    <Card>
      <div className="space-y-4">
        {/* Queue Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-200">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">
              QC Batch Queue
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {needsAttention > 0 ? (
                <>
                  <span className="font-medium text-slate-900">{needsAttention}</span> receipt
                  {needsAttention !== 1 ? 's' : ''} need attention
                </>
              ) : (
                'All receipts classified'
              )}
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-slate-900">{completedCount}</div>
            <div className="text-xs text-slate-500">of {totalInQueue}</div>
          </div>
        </div>

        {/* Queue Items */}
        {isLoading ? (
          <div className="py-8 text-center text-sm text-slate-500">Loading receipts...</div>
        ) : sortedReceipts.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-slate-500">No receipts in queue</p>
          </div>
        ) : (
          <div className="space-y-2">
            {sortedReceipts.map((item) => {
              const isActive = item.receipt.id === activeReceiptId
              const isComplete = item.qcProgress.complete === item.totalLines
              const progress =
                item.totalLines > 0
                  ? Math.round((item.qcProgress.complete / item.totalLines) * 100)
                  : 0

              return (
                <button
                  key={item.receipt.id}
                  onClick={() => onSelectReceipt(item.receipt.id)}
                  className={`
                    w-full text-left rounded-lg border transition-all
                    ${
                      isActive
                        ? 'border-indigo-300 bg-indigo-50 shadow-sm'
                        : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                    }
                  `}
                >
                  <div className="p-3">
                    {/* Receipt Info */}
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-semibold text-slate-900 font-mono">
                            {item.receipt.id.slice(-8)}
                          </span>
                          {isComplete && (
                            <Badge className="bg-green-100 text-green-700 text-xs">
                              Complete
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-slate-600">
                          PO: {item.receipt.purchaseOrderNumber || item.receipt.purchaseOrderId}
                        </div>
                      </div>
                      <div className="text-right ml-3">
                        <div className="text-xs font-medium text-slate-700">
                          {formatNumber(item.totalQuantity)} units
                        </div>
                        <div className="text-xs text-slate-500">
                          {formatDate(item.receipt.receivedAt)}
                        </div>
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="mb-2">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-slate-600">
                          {item.qcProgress.complete} of {item.totalLines} lines
                        </span>
                        <span
                          className={`font-semibold ${isComplete ? 'text-green-700' : 'text-indigo-600'}`}
                        >
                          {progress}%
                        </span>
                      </div>
                      <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all ${isComplete ? 'bg-green-500' : 'bg-indigo-500'}`}
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>

                    {/* Status Breakdown */}
                    {!isComplete && (
                      <div className="flex items-center gap-3 text-xs">
                        {item.qcProgress.pending > 0 && (
                          <div className="flex items-center gap-1">
                            <div className="w-2 h-2 rounded-full bg-slate-400" />
                            <span className="text-slate-600">
                              {item.qcProgress.pending} pending
                            </span>
                          </div>
                        )}
                        {item.qcProgress.inProgress > 0 && (
                          <div className="flex items-center gap-1">
                            <div className="w-2 h-2 rounded-full bg-blue-400" />
                            <span className="text-slate-600">
                              {item.qcProgress.inProgress} in progress
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {/* Quick Actions */}
        {sortedReceipts.length > 0 && (
          <div className="pt-3 border-t border-slate-200">
            <Button
              size="sm"
              variant="secondary"
              className="w-full"
              onClick={() => {
                // Find first receipt that needs attention
                const nextReceipt = sortedReceipts.find(
                  (r) => r.qcProgress.complete < r.totalLines
                )
                if (nextReceipt) {
                  onSelectReceipt(nextReceipt.receipt.id)
                }
              }}
              disabled={needsAttention === 0}
            >
              {needsAttention > 0 ? 'Next Receipt →' : 'All Complete ✓'}
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
}
