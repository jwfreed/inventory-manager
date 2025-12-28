import type { WorkOrder } from '@api/types'
import { Badge, DataTable } from '@shared/ui'
import { formatNumber } from '@shared/formatters'

type Props = {
  rows: WorkOrder[]
  onSelect: (row: WorkOrder) => void
  formatOutput: (row: WorkOrder) => string
  remaining: (row: WorkOrder) => number
}

export function WorkOrdersTable({ rows, onSelect, formatOutput, remaining }: Props) {
  return (
    <DataTable
      rows={rows}
      rowKey={(row) => row.id}
      onRowClick={onSelect}
      columns={[
        {
          id: 'number',
          header: 'WO Number',
          cell: (row) => <span className="font-semibold text-slate-900">{row.workOrderNumber}</span>,
        },
        {
          id: 'status',
          header: 'Status',
          cell: (row) => <Badge variant="neutral">{row.status}</Badge>,
        },
        {
          id: 'output',
          header: 'Output item',
          cell: (row) => (
            <div>
              <div className="font-medium text-slate-900">{formatOutput(row)}</div>
              {!row.outputItemName && !row.outputItemSku && (
                <div className="text-xs text-slate-500">{row.outputItemId}</div>
              )}
            </div>
          ),
        },
        {
          id: 'planned',
          header: 'Planned',
          align: 'right',
          cell: (row) => `${formatNumber(row.quantityPlanned)} ${row.outputUom}`,
        },
        {
          id: 'completed',
          header: 'Completed',
          align: 'right',
          cell: (row) => `${formatNumber(row.quantityCompleted ?? 0)} ${row.outputUom}`,
        },
        {
          id: 'remaining',
          header: 'Remaining',
          align: 'right',
          cell: (row) => `${formatNumber(remaining(row))} ${row.outputUom}`,
        },
      ]}
    />
  )
}
