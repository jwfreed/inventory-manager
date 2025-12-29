import type { InventoryAdjustmentLine } from '@api/types'
import { DataTable } from '@shared/ui'
import { formatNumber } from '@shared/formatters'
import { cn } from '@lib/utils'

type Props = {
  lines: InventoryAdjustmentLine[]
}

export function AdjustmentLinesTable({ lines }: Props) {
  return (
    <DataTable
      rows={lines}
      rowKey={(line) => line.id}
      emptyMessage="No adjustment lines yet."
      columns={[
        {
          id: 'item',
          header: 'Item',
          cell: (line) =>
            line.itemSku || line.itemName ? (
              <div>
                <div className="font-medium text-slate-900">{line.itemSku || line.itemName}</div>
                {line.itemSku && line.itemName && (
                  <div className="text-xs text-slate-500">{line.itemName}</div>
                )}
              </div>
            ) : (
              line.itemId
            ),
        },
        {
          id: 'location',
          header: 'Location',
          cell: (line) =>
            line.locationCode || line.locationName ? (
              <div>
                <div className="font-medium text-slate-900">
                  {line.locationCode || line.locationName}
                </div>
                {line.locationCode && line.locationName && (
                  <div className="text-xs text-slate-500">{line.locationName}</div>
                )}
              </div>
            ) : (
              line.locationId
            ),
        },
        {
          id: 'uom',
          header: 'UOM',
          cell: (line) => line.uom,
        },
        {
          id: 'quantity',
          header: 'Quantity Δ',
          align: 'right',
          cell: (line) => {
            const qty = line.quantityDelta ?? 0
            const sign = qty > 0 ? '+' : qty < 0 ? '−' : ''
            return (
              <span
                className={cn(
                  'font-semibold',
                  qty > 0 ? 'text-green-700' : qty < 0 ? 'text-red-600' : 'text-slate-700',
                )}
              >
                {sign}
                {formatNumber(Math.abs(qty))}
              </span>
            )
          },
        },
        {
          id: 'reason',
          header: 'Reason',
          cell: (line) => line.reasonCode || '—',
        },
        {
          id: 'notes',
          header: 'Notes',
          cell: (line) => line.notes || '—',
        },
      ]}
    />
  )
}
