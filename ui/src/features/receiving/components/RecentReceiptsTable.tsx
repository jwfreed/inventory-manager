import type { PurchaseOrderReceipt } from '@api/types'
import { Badge, Button, DataTable } from '@shared/ui'

// Format relative time (e.g., "2 days ago")
function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

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
              className="text-brand-700 underline font-mono text-xs"
              onClick={() => onLoad(rec.id)}
              title={rec.id}
            >
              {rec.id.slice(0, 8)}
            </button>
          ),
        },
        {
          id: 'po',
          header: 'PO',
          cell: (rec) => (
            <span className="font-mono text-xs" title={`PO: ${rec.purchaseOrderId}`}>
              {rec.purchaseOrderNumber || rec.purchaseOrderId.slice(0, 8)}
            </span>
          ),
        },
        {
          id: 'items',
          header: 'Items',
          cell: (rec) => {
            const lines = rec.lines ?? []
            if (lines.length === 0) return <span className="text-xs text-slate-500">—</span>
            
            const uniqueItems = Array.from(
              new Map(
                lines
                  .filter((line) => line.itemSku || line.itemName)
                  .map((line) => [line.itemId, { sku: line.itemSku, name: line.itemName }])
              ).values()
            )
            
            if (uniqueItems.length === 0) return <span className="text-xs text-slate-500">—</span>
            if (uniqueItems.length === 1) {
              const item = uniqueItems[0]
              return (
                <div className="text-xs min-w-[100px] max-w-[150px]">
                  <div className="font-medium text-slate-800 truncate" title={item.name || ''}>{item.name || '—'}</div>
                  {item.sku && <div className="text-slate-500 truncate" title={item.sku}>{item.sku}</div>}
                </div>
              )
            }
            
            return (
              <div className="text-xs text-slate-600">
                {uniqueItems.length} items
              </div>
            )
          },
        },
        {
          id: 'receivedAt',
          header: 'Received',
          cell: (rec) => (
            <span className="text-xs" title={new Date(rec.receivedAt).toLocaleString()}>
              {formatRelativeTime(rec.receivedAt)}
            </span>
          ),
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
            <Badge variant={rec.hasPutaway ? 'warning' : 'neutral'}>
              {rec.hasPutaway ? 'In progress' : 'Pending'}
            </Badge>
          ),
        },
        {
          id: 'status',
          header: 'Status',
          cell: (rec) => (
            <Badge variant={rec.status === 'voided' ? 'danger' : 'success'}>
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
