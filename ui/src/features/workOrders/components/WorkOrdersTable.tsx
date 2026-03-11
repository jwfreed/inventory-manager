import type { WorkOrder } from '@api/types'
import { Badge, DataTable, StatusCell, formatStatusLabel, statusTone } from '@shared/ui'
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
  return (
    <DataTable
      stickyHeader
      keyboardNavigation
      rows={rows}
      rowKey={(row) => row.id}
      onRowClick={onSelect}
      onRowOpen={onSelect}
      shortcutActions={[
        {
          key: 'w',
          run: onSelect,
        },
      ]}
      getRowState={(row) =>
        row.status?.toLowerCase() === 'canceled'
          ? 'danger'
          : row.status?.toLowerCase() === 'draft'
            ? 'warning'
            : 'default'
      }
      rowClassName={(row) =>
        cn(
          'group',
          row.status?.toLowerCase() === 'completed' && 'opacity-70',
        )
      }
      rowActions={(row) => (
        <Link
          className="inline-flex rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
          to={`/work-orders/${row.id}`}
          onClick={(event) => event.stopPropagation()}
        >
          View
        </Link>
      )}
      columns={[
        {
          id: 'number',
          header: 'WO Number',
          priority: 'primary',
          cell: (row) => (
            <div className="space-y-1">
              <Link
                className="font-semibold text-brand-700 underline"
                to={`/work-orders/${row.id}`}
                onClick={(event) => event.stopPropagation()}
              >
                {row.number}
              </Link>
              {row.description && <div className="text-xs text-slate-500">{row.description}</div>}
            </div>
          ),
        },
        {
          id: 'status',
          header: 'Status',
          cell: (row) => (
            <div className="space-y-1">
              <StatusCell
                label={formatStatusLabel(row.status)}
                tone={statusTone(row.status)}
                meta={row.status?.toLowerCase() === 'draft' ? 'No inventory impact' : undefined}
                compact
              />
              <Badge variant={row.kind === 'disassembly' ? 'info' : 'neutral'}>
                {row.kind === 'disassembly' ? 'Disassembly' : 'Production'}
              </Badge>
            </div>
          ),
        },
        {
          id: 'output',
          header: 'Output item',
          cell: (row) => (
            <div>
              <div className="font-medium text-slate-900">{formatOutput(row)}</div>
              {row.kind === 'disassembly' && (
                <div className="text-xs text-slate-500">Input item</div>
              )}
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
          cellClassName: 'hidden',
        },
      ]}
    />
  )
}
