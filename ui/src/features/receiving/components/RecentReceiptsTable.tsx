import type { PurchaseOrderReceipt } from '@api/types'
import { Badge, Button, DataTable } from '@shared/ui'

type Props = {
  receipts: PurchaseOrderReceipt[]
  onLoad: (id: string) => void
  onVoid: (id: string) => void
  voidDisabled?: boolean
}

export function RecentReceiptsTable({ receipts, onLoad, onVoid, voidDisabled }: Props) {
  return (
    <DataTable
      rows={receipts}
      rowKey={(rec) => rec.id}
      columns={[
        {
          id: 'receipt',
          header: 'Receipt',
          cell: (rec) => (
            <button
              type="button"
              className="text-brand-700 underline"
              onClick={() => onLoad(rec.id)}
            >
              {rec.id.slice(0, 8)}…
            </button>
          ),
        },
        {
          id: 'po',
          header: 'PO',
          cell: (rec) => rec.purchaseOrderId,
        },
        {
          id: 'receivedAt',
          header: 'Received at',
          cell: (rec) => rec.receivedAt,
        },
        {
          id: 'qc',
          header: 'QC',
          cell: (rec) => {
            const firstLineId = rec.lines?.[0]?.id ?? ''
            const params = new URLSearchParams({
              receiptId: rec.id,
              ...(firstLineId ? { qcLineId: firstLineId } : {}),
            })
            return (
              <a className="text-xs text-slate-500 underline" href={`/receiving?${params.toString()}`}>
                Review QC
              </a>
            )
          },
        },
        {
          id: 'putaway',
          header: 'Putaway',
          cell: (rec) => (
            <Badge variant={rec.hasPutaway ? 'info' : 'neutral'}>
              {rec.hasPutaway ? 'Putaway started' : 'Not started'}
            </Badge>
          ),
        },
        {
          id: 'status',
          header: 'Status',
          cell: (rec) => (
            <Badge variant={rec.status === 'voided' ? 'danger' : 'info'}>
              {rec.status === 'voided' ? 'Voided' : 'Posted'}
            </Badge>
          ),
        },
        {
          id: 'actions',
          header: 'Actions',
          align: 'right',
          cell: (rec) => (
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => onLoad(rec.id)}>
                Load
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={voidDisabled || rec.status === 'voided'}
                onClick={() => {
                  if (confirm('Void this receipt? (Only allowed if no putaway exists)')) {
                    onVoid(rec.id)
                  }
                }}
              >
                Void
              </Button>
            </div>
          ),
          cellClassName: 'py-2',
        },
      ]}
    />
  )
}
