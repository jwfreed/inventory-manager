import type { ReactNode } from 'react'
import { cn } from '../../../lib/utils'

export type DataTableColumn<T> = {
  id: string
  header: ReactNode
  cell: (row: T) => ReactNode
  align?: 'left' | 'right'
  cellClassName?: string
}

type Props<T> = {
  columns: DataTableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  emptyMessage?: string
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyMessage = 'No data available.',
}: Props<T>) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50">
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                className={cn(
                  'px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500',
                  column.align === 'right' ? 'text-right' : 'text-left',
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 bg-white">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-6 text-sm text-slate-500">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} className="h-9 transition-colors hover:bg-slate-50">
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={cn(
                      'px-4 py-2 text-sm text-slate-800',
                      column.align === 'right' ? 'text-right' : 'text-left',
                      column.cellClassName,
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
