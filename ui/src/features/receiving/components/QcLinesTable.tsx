import type { PurchaseOrderReceiptLine } from '@api/types'
import { Badge, Button, DataTable } from '@shared/ui'
import { getQcBreakdown, getQcStatus } from '../utils'

type Props = {
  lines: PurchaseOrderReceiptLine[]
  activeLineId: string
  onSelectLine: (id: string) => void
  receiptId?: string
}

export function QcLinesTable({ lines, activeLineId, onSelectLine, receiptId }: Props) {
  const buildQcLink = (lineId: string) => {
    if (!receiptId) return ''
    const params = new URLSearchParams({
      receiptId,
      qcLineId: lineId,
    })
    return `/receiving?${params.toString()}`
  }

  return (
    <DataTable
      rows={lines}
      rowKey={(line) => line.id}
      rowClassName={(line) => (line.id === activeLineId ? 'bg-slate-50' : undefined)}
      columns={[
        {
          id: 'line',
          header: 'Line',
          cell: (line) => `${line.id.slice(0, 8)}...`,
          cellClassName: 'font-mono text-xs text-slate-600',
        },
        {
          id: 'item',
          header: 'Item',
          cell: (line) =>
            `${line.itemSku ?? line.itemId ?? 'Item'}${line.itemName ? ` - ${line.itemName}` : ''}`,
        },
        {
          id: 'received',
          header: 'Received',
          cell: (line) => `${line.quantityReceived} ${line.uom}`,
        },
        {
          id: 'accepted',
          header: 'Accepted',
          cell: (line) => getQcBreakdown(line).accept,
        },
        {
          id: 'hold',
          header: 'Hold',
          cell: (line) => getQcBreakdown(line).hold,
        },
        {
          id: 'reject',
          header: 'Reject',
          cell: (line) => getQcBreakdown(line).reject,
        },
        {
          id: 'remaining',
          header: 'Remaining',
          cell: (line) => getQcBreakdown(line).remaining,
        },
        {
          id: 'status',
          header: 'Status',
          cell: (line) => {
            const status = getQcStatus(line)
            return <Badge variant={status.variant}>{status.label}</Badge>
          },
        },
        {
          id: 'putaway',
          header: 'Putaway',
          cell: (line) => {
            const qc = getQcBreakdown(line)
            const availableQty = line.availableForNewPutaway ?? qc.accept
            const remainingQty = line.remainingQuantityToPutaway ?? 0
            const blockedReason = line.putawayBlockedReason ?? ''
            let putawayLabel = 'Blocked'
            let putawayVariant: 'neutral' | 'success' | 'warning' | 'danger' | 'info' = 'warning'
            if (line.putawayStatus === 'complete') {
              putawayLabel = 'Putaway complete'
              putawayVariant = 'success'
            } else if (line.putawayStatus === 'partial') {
              putawayLabel = 'Partially put away'
              putawayVariant = 'info'
            } else if (availableQty > 0) {
              putawayLabel = `Available ${availableQty}`
              putawayVariant = 'success'
            } else if (remainingQty > 0) {
              putawayLabel = 'Planned in draft'
              putawayVariant = 'neutral'
            } else if (qc.hold > 0) {
              putawayLabel = 'On hold'
              putawayVariant = 'warning'
            } else if (qc.reject > 0) {
              putawayLabel = 'Rejected'
              putawayVariant = 'danger'
            }
            return (
              <div>
                <Badge variant={putawayVariant}>{putawayLabel}</Badge>
                {blockedReason && availableQty <= 0 && (
                  <div className="mt-1 text-xs text-slate-500">{blockedReason}</div>
                )}
              </div>
            )
          },
        },
        {
          id: 'action',
          header: 'Action',
          align: 'right',
          cell: (line) => {
            const qcLink = buildQcLink(line.id)
            return (
              <div className="flex justify-end gap-2">
                {qcLink && (
                  <a className="text-xs text-slate-500 underline" href={qcLink}>
                    Link
                  </a>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant={activeLineId === line.id ? 'primary' : 'secondary'}
                  onClick={() => onSelectLine(line.id)}
                >
                  QC
                </Button>
              </div>
            )
          },
        },
      ]}
    />
  )
}
