import type { Putaway } from '../../../api/types'
import { DataTable } from '../../../shared'

type Props = {
  putaway: Putaway
}

export function PutawaySummaryTable({ putaway }: Props) {
  return (
    <div>
      <div className="text-sm text-slate-700">Status: {putaway.status}</div>
      <div className="mt-2">
        <DataTable
          rows={putaway.lines}
          rowKey={(line) => line.id}
          columns={[
            { id: 'line', header: 'Line', cell: (line) => line.lineNumber },
            { id: 'receiptLine', header: 'Receipt line', cell: (line) => line.purchaseOrderReceiptLineId },
            {
              id: 'fromTo',
              header: 'From → To',
              cell: (line) => `${line.fromLocationId} → ${line.toLocationId}`,
            },
            {
              id: 'qty',
              header: 'Qty',
              cell: (line) => `${line.quantityPlanned} ${line.uom}`,
            },
            { id: 'status', header: 'Status', cell: (line) => line.status },
          ]}
        />
      </div>
    </div>
  )
}
