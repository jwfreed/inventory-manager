import type { PurchaseOrderReceipt } from '@api/types'
import { Button, DataTable } from '@shared/ui'

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
          id: 'putaway',
          header: 'Putaway',
          cell: (rec) => (
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                rec.hasPutaway ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {rec.hasPutaway ? 'Putaway started' : 'Not started'}
            </span>
          ),
        },
        {
          id: 'status',
          header: 'Status',
          cell: (rec) => (
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                rec.status === 'voided' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {rec.status === 'voided' ? 'Voided' : 'Posted'}
            </span>
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
