import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

type Column<T> = {
  id: string
  header: ReactNode
  cell: (row: T) => ReactNode
  align?: 'left' | 'right'
  priority?: 'primary' | 'secondary' | 'anomaly'
  truncate?: boolean
  mobileLabel?: string
  headerClassName?: string
  cellClassName?: string
}

type Props<T> = {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  emptyMessage?: string
  emptyState?: ReactNode
  className?: string
  containerClassName?: string
  stickyHeader?: boolean
  rowClassName?: (row: T) => string | undefined
  getRowState?: (row: T) => 'default' | 'warning' | 'danger'
  rowActions?: (row: T) => ReactNode
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyMessage = 'No data yet.',
  emptyState,
  className,
  containerClassName,
  stickyHeader = false,
  rowClassName,
  getRowState,
  rowActions,
}: Props<T>) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-2xl border border-slate-200 bg-white',
        className,
        containerClassName,
      )}
    >
      <table className="min-w-full divide-y divide-slate-200">
        <thead className={cn('bg-slate-50', stickyHeader ? 'sticky top-0 z-10' : undefined)}>
          <tr>
            {columns.map((column) => {
              const alignClass = column.align === 'right' ? 'text-right' : 'text-left'
              return (
                <th
                  key={column.id}
                  scope="col"
                  className={cn(
                    'px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500',
                    alignClass,
                    column.headerClassName,
                  )}
                >
                  {column.header}
                </th>
              )
            })}
            {rowActions ? (
              <th className="px-4 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 bg-white">
          {rows.length === 0 ? (
            <tr>
              <td className="px-4 py-6 text-sm text-slate-500" colSpan={columns.length + (rowActions ? 1 : 0)}>
                {emptyState ?? emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={cn(
                  'h-9 transition-colors hover:bg-slate-50',
                  getRowState?.(row) === 'warning' && 'bg-amber-50/40 hover:bg-amber-50/60',
                  getRowState?.(row) === 'danger' && 'bg-rose-50/40 hover:bg-rose-50/60',
                  onRowClick && 'cursor-pointer',
                  rowClassName?.(row),
                )}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((column) => {
                  const alignClass = column.align === 'right' ? 'text-right' : 'text-left'
                  return (
                    <td
                      key={column.id}
                      className={cn(
                        'px-4 py-2 text-sm text-slate-800',
                        alignClass,
                        column.truncate && 'max-w-[280px] truncate',
                        column.priority === 'primary' && 'font-medium text-slate-900',
                        column.priority === 'anomaly' && 'text-rose-700',
                        column.cellClassName,
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  )
                })}
                {rowActions ? (
                  <td className="px-4 py-2 text-right" onClick={(event) => event.stopPropagation()}>
                    {rowActions(row)}
                  </td>
                ) : null}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
