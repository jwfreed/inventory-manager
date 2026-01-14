import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

type Column<T> = {
  id: string
  header: ReactNode
  cell: (row: T) => ReactNode
  align?: 'left' | 'right'
  headerClassName?: string
  cellClassName?: string
}

type Props<T> = {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  emptyMessage?: string
  className?: string
  containerClassName?: string
  stickyHeader?: boolean
  rowClassName?: (row: T) => string | undefined
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyMessage = 'No data yet.',
  className,
  containerClassName,
  stickyHeader = false,
  rowClassName,
}: Props<T>) {
  return (
    <div className={cn('overflow-hidden rounded-xl border border-slate-200', className, containerClassName)}>
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
                    'px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500',
                    alignClass,
                    column.headerClassName,
                  )}
                >
                  {column.header}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 bg-white">
          {rows.length === 0 ? (
            <tr>
              <td className="px-4 py-6 text-sm text-slate-500" colSpan={columns.length}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={cn(
                  'hover:bg-slate-50',
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
                      className={cn('px-4 py-3 text-sm text-slate-800', alignClass, column.cellClassName)}
                    >
                      {column.cell(row)}
                    </td>
                  )
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
