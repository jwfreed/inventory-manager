import { formatNumber } from '@shared/formatters'
import { DataTable } from '@shared/ui'
import type { MovementLine } from '../../../api/types'
import { cn } from '../../../lib/utils'

type Props = {
  lines: MovementLine[]
}

export function MovementLinesTable({ lines }: Props) {
  return (
    <DataTable
      rows={lines}
      rowKey={(line) => line.id}
      getRowState={(line) => ((line.quantityDelta ?? 0) < 0 ? 'warning' : 'default')}
      columns={[
        {
          id: 'item',
          header: 'Item',
          priority: 'primary',
          cell: (line) =>
            line.itemSku || line.itemName ? (
              <div>
                <div className="font-medium">{line.itemSku || line.itemName}</div>
                {line.itemName && line.itemSku ? (
                  <div className="text-xs text-slate-500">{line.itemName}</div>
                ) : null}
              </div>
            ) : (
              line.itemId
            ),
        },
        {
          id: 'location',
          header: 'Location',
          cell: (line) => (
            <div>
              <div>{line.locationCode || line.locationName || line.locationId}</div>
              {line.locationName ? (
                <div className="text-xs text-slate-500">{line.locationName}</div>
              ) : null}
            </div>
          ),
        },
        {
          id: 'uom',
          header: 'UOM',
          cell: (line) => line.uom,
        },
        {
          id: 'quantity',
          header: 'Quantity delta',
          align: 'right',
          priority: 'anomaly',
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
      ]}
    />
  )
}
