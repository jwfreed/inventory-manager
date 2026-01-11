import { Badge, Card, DataTable } from '@shared/ui'
import { formatDate, formatNumber } from '@shared/formatters'
import type { PurchaseOrderReceipt, PurchaseOrderReceiptLine } from '@api/types'

type Props = {
  receipt: PurchaseOrderReceipt
  showQcStatus?: boolean
}

export function ReceiptDocument({ receipt, showQcStatus = false }: Props) {
  const statusColors: Record<string, string> = {
    draft: 'bg-slate-100 text-slate-700',
    posted: 'bg-green-100 text-green-800',
    voided: 'bg-red-100 text-red-800',
  }

  const lines = receipt.lines || []
  const totalReceived = lines.reduce((sum, line) => sum + line.quantityReceived, 0)
  const totalExpected = lines.reduce((sum, line) => sum + (line.expectedQuantity || 0), 0)
  const hasDiscrepancies = lines.some(
    (line) => line.quantityReceived !== (line.expectedQuantity || 0)
  )

  return (
    <Card>
      <div className="space-y-6">
        {/* Document Header */}
        <div className="border-b border-slate-200 pb-4">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <h3 className="text-lg font-semibold text-slate-900">
                  Receipt {receipt.id}
                </h3>
                <Badge className={statusColors[receipt.status || 'draft']}>
                  {receipt.status}
                </Badge>
                {hasDiscrepancies && (
                  <Badge className="bg-amber-100 text-amber-800">Has discrepancies</Badge>
                )}
              </div>
              <div className="text-sm text-slate-500">
                {receipt.purchaseOrderId && (
                  <span className="font-mono">PO: {receipt.purchaseOrderId}</span>
                )}
              </div>
            </div>
            <div className="text-right text-sm">
              <div className="text-slate-500">Received</div>
              <div className="font-medium text-slate-900">
                {formatDate(receipt.receivedAt)}
              </div>
            </div>
          </div>
        </div>

        {/* Metadata Grid */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-slate-500 text-xs uppercase tracking-wide mb-1">
              Receiving location
            </div>
            <div className="text-slate-900 font-medium">{receipt.receivedToLocationId || 'N/A'}</div>
          </div>
          {receipt.notes && (
            <div className="col-span-2">
              <div className="text-slate-500 text-xs uppercase tracking-wide mb-1">Notes</div>
              <div className="text-slate-700 text-sm bg-slate-50 rounded p-2">
                {receipt.notes}
              </div>
            </div>
          )}
        </div>

        {/* Receipt Lines */}
        <div>
          <div className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">
            Receipt Lines
          </div>
          <DataTable
            rows={lines}
            rowKey={(line) => line.id}
            columns={[
              {
                id: 'line',
                header: 'Line',
                cell: (line) => line.purchaseOrderLineId.slice(-4),
                cellClassName: 'font-mono text-xs text-slate-600',
              },
              {
                id: 'item',
                header: 'Item',
                cell: (line) => (
                  <div>
                    <div className="text-sm font-medium text-slate-900">{line.itemName || line.itemSku || line.itemId}</div>
                  </div>
                ),
              },
              {
                id: 'ordered',
                header: 'Ordered',
                cell: (line) => formatNumber(line.expectedQuantity || 0),
                align: 'right' as const,
              },
              {
                id: 'received',
                header: 'Received',
                cell: (line) => (
                  <span
                    className={
                      line.quantityReceived !== (line.expectedQuantity || 0)
                        ? 'font-semibold text-amber-700'
                        : ''
                    }
                  >
                    {formatNumber(line.quantityReceived)}
                  </span>
                ),
                align: 'right' as const,
              },
              {
                id: 'variance',
                header: 'Variance',
                cell: (line) => {
                  const variance = line.quantityReceived - (line.expectedQuantity || 0)
                  if (variance === 0) return <span className="text-slate-400">—</span>
                  return (
                    <span className={variance > 0 ? 'text-green-700' : 'text-red-700'}>
                      {variance > 0 ? '+' : ''}
                      {formatNumber(variance)}
                    </span>
                  )
                },
                align: 'right' as const,
              },
              ...(showQcStatus
                ? [
                    {
                      id: 'qc',
                      header: 'QC Status',
                      cell: (line: PurchaseOrderReceiptLine) => {
                        const summary = line.qcSummary
                        if (!summary) {
                          return <Badge className="bg-slate-100 text-slate-600">Pending</Badge>
                        }
                        if (summary.remainingUninspectedQuantity === 0) {
                          return <Badge className="bg-green-100 text-green-700">Complete</Badge>
                        }
                        return <Badge className="bg-blue-100 text-blue-700">In Progress</Badge>
                      },
                    },
                  ]
                : []),
            ]}
          />
        </div>

        {/* Summary Totals */}
        <div className="border-t border-slate-200 pt-4">
          <div className="flex justify-end">
            <div className="grid grid-cols-3 gap-6 text-sm">
              <div className="text-right">
                <div className="text-slate-500 mb-1">Expected</div>
                <div className="text-lg font-semibold text-slate-900">
                  {formatNumber(totalExpected)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-slate-500 mb-1">Received</div>
                <div className="text-lg font-semibold text-slate-900">
                  {formatNumber(totalReceived)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-slate-500 mb-1">Variance</div>
                <div
                  className={`text-lg font-semibold ${
                    totalReceived === totalExpected
                      ? 'text-slate-900'
                      : totalReceived > totalExpected
                        ? 'text-green-700'
                        : 'text-red-700'
                  }`}
                >
                  {totalReceived === totalExpected
                    ? '—'
                    : `${totalReceived > totalExpected ? '+' : ''}${formatNumber(totalReceived - totalExpected)}`}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* QC Summary (if enabled) */}
        {showQcStatus && (
          <div className="border-t border-slate-200 pt-4">
            <div className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-3">
              QC Summary
            </div>
            <div className="grid grid-cols-4 gap-4">
              <div className="rounded-lg bg-green-50 p-3 text-center">
                <div className="text-xs font-medium text-green-700 uppercase mb-1">Accepted</div>
                <div className="text-2xl font-bold text-green-900">
                  {formatNumber(
                    lines.reduce((sum, line) => sum + (line.qcSummary?.breakdown.accept || 0), 0)
                  )}
                </div>
              </div>
              <div className="rounded-lg bg-amber-50 p-3 text-center">
                <div className="text-xs font-medium text-amber-700 uppercase mb-1">Hold</div>
                <div className="text-2xl font-bold text-amber-900">
                  {formatNumber(
                    lines.reduce((sum, line) => sum + (line.qcSummary?.breakdown.hold || 0), 0)
                  )}
                </div>
              </div>
              <div className="rounded-lg bg-red-50 p-3 text-center">
                <div className="text-xs font-medium text-red-700 uppercase mb-1">Rejected</div>
                <div className="text-2xl font-bold text-red-900">
                  {formatNumber(
                    lines.reduce((sum, line) => sum + (line.qcSummary?.breakdown.reject || 0), 0)
                  )}
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 p-3 text-center">
                <div className="text-xs font-medium text-slate-700 uppercase mb-1">Remaining</div>
                <div className="text-2xl font-bold text-slate-900">
                  {formatNumber(
                    lines.reduce((sum, line) => sum + (line.qcSummary?.remainingUninspectedQuantity || 0), 0)
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
