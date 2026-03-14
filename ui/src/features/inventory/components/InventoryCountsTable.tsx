import type { InventoryCount } from '@api/types'
import { Badge, DataTable, formatStatusLabel, statusTone, statusToneToBadgeVariant } from '@shared/ui'
import { formatNumber } from '@shared/formatters'
import { Link } from 'react-router-dom'

type Props = {
  rows: InventoryCount[]
  onSelect: (row: InventoryCount) => void
}

export function InventoryCountsTable({ rows, onSelect }: Props) {
  return (
    <DataTable
      rows={rows}
      rowKey={(row) => row.id}
      onRowClick={onSelect}
      rowActions={(row) => (
        <Link
          className="inline-flex rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
          to={`/inventory-counts/${row.id}`}
          onClick={(event) => event.stopPropagation()}
        >
          View
        </Link>
      )}
      columns={[
        {
          id: 'id',
          header: 'Count',
          cell: (row) => (
            <div className="space-y-1">
              <div className="font-semibold text-slate-900">{row.id}</div>
              <div className="text-xs text-slate-500">{new Date(row.countedAt).toLocaleString()}</div>
            </div>
          ),
        },
        {
          id: 'status',
          header: 'Status',
          cell: (row) => (
            <Badge variant={statusToneToBadgeVariant(statusTone(row.status))}>
              {formatStatusLabel(row.status)}
            </Badge>
          ),
        },
        {
          id: 'lines',
          header: 'Lines',
          align: 'right',
          cell: (row) => formatNumber(row.summary.lineCount),
        },
        {
          id: 'variance',
          header: 'Abs variance',
          align: 'right',
          cell: (row) => formatNumber(row.summary.totalAbsVariance),
        },
        {
          id: 'hits',
          header: 'Hit rate',
          align: 'right',
          cell: (row) => `${formatNumber(row.summary.hitRate * 100)}%`,
        },
      ]}
    />
  )
}
