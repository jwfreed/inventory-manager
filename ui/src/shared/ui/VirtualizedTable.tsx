import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

export type Column<T> = {
  key: string
  header: string
  width?: string
  align?: 'left' | 'right' | 'center'
  className?: string
  headerClassName?: string
  render: (row: T, index: number) => React.ReactNode
}

type VirtualizedTableProps<T> = {
  data: T[]
  columns: Column<T>[]
  rowHeight?: number
  maxHeight?: number
  getRowKey: (row: T, index: number) => string
  onRowClick?: (row: T) => void
  emptyMessage?: string
}

/**
 * A virtualized table component for rendering large datasets efficiently.
 * Only renders visible rows plus a small overscan buffer.
 * 
 * Use this for tables with 100+ rows to prevent DOM bloat.
 */
export function VirtualizedTable<T>({
  data,
  columns,
  rowHeight = 52,
  maxHeight = 600,
  getRowKey,
  onRowClick,
  emptyMessage = 'No data found',
}: VirtualizedTableProps<T>) {
  'use no memo' // Disable React Compiler memoization due to useVirtualizer incompatibility
  
  const parentRef = useRef<HTMLDivElement>(null)

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 10, // Render 10 extra rows above/below viewport
  })

  if (data.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500">
        {emptyMessage}
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      {/* Header */}
      <div className="bg-slate-50 border-b border-slate-200">
        <div className="flex">
          {columns.map((col) => (
            <div
              key={col.key}
              className={`px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider ${
                col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'
              } ${col.headerClassName || ''}`}
              style={{ width: col.width, minWidth: col.width, flex: col.width ? undefined : 1 }}
            >
              {col.header}
            </div>
          ))}
        </div>
      </div>

      {/* Virtualized body */}
      <div
        ref={parentRef}
        className="overflow-auto bg-white"
        style={{ maxHeight }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = data[virtualRow.index]
            const rowKey = getRowKey(row, virtualRow.index)
            
            return (
              <div
                key={rowKey}
                className={`absolute top-0 left-0 w-full flex border-b border-slate-100 ${
                  onRowClick ? 'cursor-pointer hover:bg-slate-50' : ''
                }`}
                style={{
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((col) => (
                  <div
                    key={col.key}
                    className={`px-4 py-3 text-sm flex items-center ${
                      col.align === 'right' ? 'justify-end' : col.align === 'center' ? 'justify-center' : ''
                    } ${col.className || ''}`}
                    style={{ width: col.width, minWidth: col.width, flex: col.width ? undefined : 1 }}
                  >
                    {col.render(row, virtualRow.index)}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
      
      {/* Row count indicator */}
      <div className="bg-slate-50 border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
        {data.length.toLocaleString()} rows
      </div>
    </div>
  )
}

export default VirtualizedTable
