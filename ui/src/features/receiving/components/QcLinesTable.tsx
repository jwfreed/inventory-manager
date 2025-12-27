import type { PurchaseOrderReceiptLine } from '../../../api/types'
import { Button } from '../../../components/Button'
import { DataTable } from '../../../shared'
import { getQcBreakdown, getQcStatus } from '../utils'

type Props = {
  lines: PurchaseOrderReceiptLine[]
  activeLineId: string
  onSelectLine: (id: string) => void
}

export function QcLinesTable({ lines, activeLineId, onSelectLine }: Props) {
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
            return (
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${status.tone}`}
              >
                {status.label}
              </span>
            )
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
            let putawayTone = 'bg-amber-100 text-amber-700'
            if (availableQty > 0) {
              putawayLabel = `Available ${availableQty}`
              putawayTone = 'bg-emerald-100 text-emerald-700'
            } else if (remainingQty > 0) {
              putawayLabel = 'Planned in draft'
              putawayTone = 'bg-slate-100 text-slate-600'
            } else if (qc.accept > 0) {
              putawayLabel = 'Putaway complete'
              putawayTone = 'bg-slate-100 text-slate-600'
            } else if (qc.hold > 0) {
              putawayLabel = 'On hold'
            } else if (qc.reject > 0) {
              putawayLabel = 'Rejected'
            }
            return (
              <div>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${putawayTone}`}
                >
                  {putawayLabel}
                </span>
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
          cell: (line) => (
            <Button
              type="button"
              size="sm"
              variant={activeLineId === line.id ? 'primary' : 'secondary'}
              onClick={() => onSelectLine(line.id)}
            >
              QC
            </Button>
          ),
        },
      ]}
    />
  )
}
