import type { ReactNode } from 'react'
import { cn } from '../lib/utils'
import { Button } from './Button'

type Column<T> = {
  header: string
  accessor: keyof T
  render?: (value: T[keyof T], row: T) => ReactNode
}

type Props<T> = {
  columns: Column<T>[]
  data: T[]
  className?: string
  pagination?: {
    page: number
    pageCount: number
    onPageChange?: (page: number) => void
  }
}

export function Table<T extends Record<string, unknown>>({
  columns,
  data,
  className,
  pagination,
}: Props<T>) {
  return (
    <div className={cn('overflow-hidden rounded-xl border border-slate-200 bg-white', className)}>
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50">
          <tr>
            {columns.map((column) => (
              <th
                key={column.header}
                scope="col"
                className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 bg-white">
          {data.length === 0 ? (
            <tr>
              <td className="px-4 py-6 text-sm text-slate-500" colSpan={columns.length}>
                No data yet.
              </td>
            </tr>
          ) : (
            data.map((row, idx) => (
              <tr key={idx} className="hover:bg-slate-50">
                {columns.map((column) => (
                  <td key={String(column.accessor)} className="px-4 py-3 text-sm text-slate-800">
                    {column.render
                      ? column.render(row[column.accessor], row)
                      : (row[column.accessor] as ReactNode)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {pagination && (
        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm">
          <span className="text-slate-500">
            Page {pagination.page} of {pagination.pageCount}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => pagination.onPageChange?.(pagination.page - 1)}
              disabled={pagination.page <= 1}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => pagination.onPageChange?.(pagination.page + 1)}
              disabled={pagination.page >= pagination.pageCount}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
