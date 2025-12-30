import type { WorkOrder } from '@api/types'
import { Badge, DataTable } from '@shared/ui'
import { formatNumber } from '@shared/formatters'
import { Link } from 'react-router-dom'
import { cn } from '../../../lib/utils'

type Props = {
  rows: WorkOrder[]
  onSelect: (row: WorkOrder) => void
  formatOutput: (row: WorkOrder) => string
  remaining: (row: WorkOrder) => number
}

export function WorkOrdersTable({ rows, onSelect, formatOutput, remaining }: Props) {
  const formatStatus = (status?: string | null) => {
    if (!status) return 'Unknown'
    return status
      .replace(/_/g, ' ')
      .split(' ')
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(' ')
  }

  const statusVariant = (status?: string | null) => {
    const normalized = status?.toLowerCase()
    if (normalized === 'draft') return 'warning'
    if (normalized === 'in_progress') return 'info'
    if (normalized === 'completed') return 'success'
    if (normalized === 'canceled') return 'neutral'
    return 'neutral'
  }

  return (
    <DataTable
      rows={rows}
      rowKey={(row) => row.id}
      onRowClick={onSelect}
      rowClassName={(row) =>
        cn(
          'group',
          row.status?.toLowerCase() === 'draft' && 'bg-slate-50/40',
          row.status?.toLowerCase() === 'completed' && 'opacity-70',
        )
      }
      columns={[
        {
          id: 'number',
          header: 'WO Number',
          cell: (row) => (
            <Link
              className="font-semibold text-brand-700 underline"
              to={`/work-orders/${row.id}`}
              onClick={(event) => event.stopPropagation()}
            >
              {row.workOrderNumber}
            </Link>
          ),
        },
        {
          id: 'status',
          header: 'Status',
          cell: (row) => (
            <div className="flex items-center gap-2">
              <Badge variant={statusVariant(row.status)}>{formatStatus(row.status)}</Badge>
              {row.status?.toLowerCase() === 'draft' && (
                <span className="text-xs text-slate-500">No inventory impact</span>
              )}
            </div>
          ),
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
          cell: (row) => {
            const remainingQty = remaining(row)
            if (remainingQty <= 0) {
              return (
                <div className="flex items-center justify-end">
                  <Badge variant="success">Complete</Badge>
                </div>
              )
            }
            return (
              <div className="flex flex-col items-end">
                <span className="font-semibold text-slate-900">
                  {formatNumber(remainingQty)} {row.outputUom}
                </span>
                <span className="text-xs text-slate-500">Remaining</span>
              </div>
            )
          },
        },
        {
          id: 'chevron',
          header: '',
          align: 'right',
          cell: () => (
            <span className="text-xs text-slate-300 opacity-0 transition group-hover:opacity-60">{'>'}</span>
          ),
          cellClassName: 'w-6',
        },
      ]}
    />
  )
}
