import type { PurchaseOrderLine } from '@api/types'
import { Button, DataTable } from '@shared/ui'

const emptyMessage = 'No lines on this purchase order.'

type Props = {
  lines: PurchaseOrderLine[]
  canCloseLine?: (line: PurchaseOrderLine) => boolean
  closingLineId?: string | null
  onCloseLineRequest?: (line: PurchaseOrderLine) => void
}

export function PurchaseOrderLinesTable({
  lines,
  canCloseLine,
  closingLineId,
  onCloseLineRequest,
}: Props) {
  return (
    <DataTable
      rows={lines}
      rowKey={(row) => row.id}
      emptyMessage={emptyMessage}
      rowActions={
        onCloseLineRequest
          ? (row) =>
              canCloseLine?.(row) ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onCloseLineRequest(row)}
                  disabled={closingLineId === row.id}
                >
                  {closingLineId === row.id ? 'Closing...' : 'Close line'}
                </Button>
              ) : null
          : undefined
      }
      columns={[
        {
          id: 'line',
          header: 'Line',
          cell: (row) => row.lineNumber ?? '—',
        },
        {
          id: 'item',
          header: 'Item',
          cell: (row) => (
            <span>
              {row.itemSku ?? row.itemId}
              {row.itemName ? ` — ${row.itemName}` : ''}
            </span>
          ),
        },
        {
          id: 'qty',
          header: 'Qty',
          cell: (row) => row.quantityOrdered ?? '—',
        },
        {
          id: 'received',
          header: 'Received',
          cell: (row) => row.quantityReceived ?? '—',
        },
        {
          id: 'uom',
          header: 'UOM',
          cell: (row) => row.uom ?? '—',
        },
        {
          id: 'status',
          header: 'Status',
          cell: (row) => row.status ?? 'open',
        },
        {
          id: 'unitPrice',
          header: 'Unit Price',
          cell: (row) => row.unitPrice ? `$${row.unitPrice.toFixed(2)}` : '—',
          cellClassName: 'font-mono text-right',
        },
        {
          id: 'extendedPrice',
          header: 'Extended',
          cell: (row) => {
            if (!row.unitPrice || !row.quantityOrdered) return '—'
            const extended = row.unitPrice * row.quantityOrdered
            return `$${extended.toFixed(2)}`
          },
          cellClassName: 'font-mono text-right font-semibold',
        },
        {
          id: 'notes',
          header: 'Notes',
          cell: (row) => row.notes ?? '—',
        },
      ]}
    />
  )
}
