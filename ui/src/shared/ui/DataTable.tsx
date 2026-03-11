import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
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
  onRowOpen?: (row: T) => void
  emptyMessage?: string
  emptyState?: ReactNode
  className?: string
  containerClassName?: string
  stickyHeader?: boolean
  rowClassName?: (row: T) => string | undefined
  getRowState?: (row: T) => 'default' | 'warning' | 'danger'
  rowActions?: (row: T) => ReactNode
  keyboardNavigation?: boolean
  selectedRowKey?: string
  onSelectedRowChange?: (row: T) => void
  shortcutActions?: Array<{
    key: string
    when?: (row: T) => boolean
    run: (row: T) => void
  }>
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  onRowOpen,
  emptyMessage = 'No data yet.',
  emptyState,
  className,
  containerClassName,
  stickyHeader = false,
  rowClassName,
  getRowState,
  rowActions,
  keyboardNavigation = false,
  selectedRowKey,
  onSelectedRowChange,
  shortcutActions = [],
}: Props<T>) {
  const rowKeys = useMemo(() => rows.map((row) => rowKey(row)), [rowKey, rows])
  const [internalSelectedRowKey, setInternalSelectedRowKey] = useState<string | null>(
    rowKeys[0] ?? null,
  )
  const activeSelectedRowKey =
    selectedRowKey ??
    (internalSelectedRowKey && rowKeys.includes(internalSelectedRowKey)
      ? internalSelectedRowKey
      : rowKeys[0] ?? null)

  const selectedIndex = activeSelectedRowKey ? rowKeys.indexOf(activeSelectedRowKey) : -1

  const selectRowAtIndex = (index: number) => {
    const row = rows[index]
    if (!row) return
    const nextKey = rowKey(row)
    if (selectedRowKey === undefined) {
      setInternalSelectedRowKey(nextKey)
    }
    onSelectedRowChange?.(row)
  }

  const openRow = (row: T) => {
    if (onRowOpen) {
      onRowOpen(row)
      return
    }
    onRowClick?.(row)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!keyboardNavigation || rows.length === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const nextIndex = selectedIndex >= 0 ? Math.min(rows.length - 1, selectedIndex + 1) : 0
      selectRowAtIndex(nextIndex)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      const nextIndex = selectedIndex >= 0 ? Math.max(0, selectedIndex - 1) : 0
      selectRowAtIndex(nextIndex)
      return
    }

    if (event.key === 'Enter' && selectedIndex >= 0) {
      event.preventDefault()
      openRow(rows[selectedIndex])
      return
    }

    if (selectedIndex < 0) return

    const shortcut = shortcutActions.find((entry) => {
      const matchesKey = entry.key.toLowerCase() === event.key.toLowerCase()
      return matchesKey && (entry.when ? entry.when(rows[selectedIndex]) : true)
    })
    if (shortcut) {
      event.preventDefault()
      shortcut.run(rows[selectedIndex])
    }
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-2xl border border-slate-200 bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200',
        className,
        containerClassName,
      )}
      onKeyDown={handleKeyDown}
      tabIndex={keyboardNavigation ? 0 : undefined}
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
                  keyboardNavigation && 'focus-within:bg-slate-50',
                  activeSelectedRowKey === rowKey(row) &&
                    'bg-brand-50/80 outline outline-1 -outline-offset-1 outline-brand-300',
                  getRowState?.(row) === 'warning' && 'bg-amber-50/40 hover:bg-amber-50/60',
                  getRowState?.(row) === 'danger' && 'bg-rose-50/40 hover:bg-rose-50/60',
                  onRowClick && 'cursor-pointer',
                  rowClassName?.(row),
                )}
                onClick={() => {
                  if (keyboardNavigation) {
                    const index = rowKeys.indexOf(rowKey(row))
                    if (index >= 0) selectRowAtIndex(index)
                  }
                  onRowClick?.(row)
                }}
              >
                {columns.map((column) => {
                  const alignClass = column.align === 'right' ? 'text-right' : 'text-left'
                  return (
                    <td
                      key={column.id}
                      className={cn(
                        'px-4 py-2 text-sm text-slate-800',
                        alignClass,
                        column.align === 'right' && 'font-mono tabular-nums',
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
