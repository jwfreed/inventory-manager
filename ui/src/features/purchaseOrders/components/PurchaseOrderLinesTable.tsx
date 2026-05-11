import type { PurchaseOrderLine } from '@api/types'
import { Badge, Button, DataTable } from '@shared/ui'
import { formatNumber } from '../../../lib/formatters'

const emptyMessage = 'No lines on this purchase order.'

type Props = {
  lines: PurchaseOrderLine[]
  canCloseLine?: (line: PurchaseOrderLine) => boolean
  closingLineId?: string | null
  onCloseLineRequest?: (line: PurchaseOrderLine) => void
  showCostColumns?: boolean
}

function computeRemaining(line: PurchaseOrderLine): number {
  return (line.quantityOrdered ?? 0) - (line.quantityReceived ?? 0)
}

export function PurchaseOrderLinesTable({
  lines,
  canCloseLine,
  closingLineId,
  onCloseLineRequest,
  showCostColumns = true,
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
                  className="px-2 py-1 text-xs font-medium shadow-none"
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
          header: 'Ordered',
          cell: (row) => (row.quantityOrdered != null ? formatNumber(row.quantityOrdered) : '—'),
          align: 'right',
        },
        {
          id: 'received',
          header: 'Received',
          cell: (row) => (row.quantityReceived != null ? formatNumber(row.quantityReceived) : '—'),
          align: 'right',
        },
        {
          id: 'remaining',
          header: 'Remaining',
          cell: (row) => formatNumber(computeRemaining(row)),
          align: 'right',
        },
        {
          id: 'uom',
          header: 'UOM',
          cell: (row) => row.uom ?? '—',
        },
        {
          id: 'status',
          header: 'Status',
          cell: (row) => (
            <Badge variant={row.status === 'complete' ? 'success' : 'neutral'}>
              {row.status ?? 'open'}
            </Badge>
          ),
        },
        ...(showCostColumns
          ? [
              {
                id: 'unitPrice',
                header: 'Unit Price',
                cell: (row: PurchaseOrderLine) =>
                  row.unitPrice ? `$${row.unitPrice.toFixed(2)}` : '—',
                cellClassName: 'font-mono text-right',
              },
              {
                id: 'extendedPrice',
                header: 'Extended',
                cell: (row: PurchaseOrderLine) => {
                  if (!row.unitPrice || !row.quantityOrdered) return '—'
                  const extended = row.unitPrice * row.quantityOrdered
                  return `$${extended.toFixed(2)}`
                },
                cellClassName: 'font-mono text-right font-semibold',
              },
            ]
          : []),
        {
          id: 'notes',
          header: 'Notes',
          cell: (row) => row.notes ?? '—',
        },
      ]}
    />
  )
}
