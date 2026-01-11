import { useCallback, memo } from 'react'
import { FixedSizeList as List } from 'react-window'
import type { PurchaseOrderReceiptLine } from '../types'

type QcLineItemProps = {
  line: PurchaseOrderReceiptLine
  isActive: boolean
  isSelected: boolean
  onSelect: (lineId: string) => void
  onClick: (lineId: string) => void
}

const QcLineItem = memo(({ line, isActive, isSelected, onSelect, onClick }: QcLineItemProps) => {
  return (
    <div
      className={`
        flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer mx-2 my-1
        ${isActive ? 'bg-indigo-50 border-indigo-300' : 'bg-white border-slate-200 hover:border-slate-300'}
        ${isSelected ? 'ring-2 ring-indigo-500' : ''}
      `}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onChange={() => onSelect(line.id)}
        className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
        onClick={(e) => e.stopPropagation()}
      />
      <div className="flex-1 grid grid-cols-4 gap-4" onClick={() => onClick(line.id)}>
        <div>
          <div className="text-xs text-slate-500">Item</div>
          <div className="text-sm font-medium text-slate-900">{line.itemSku ?? line.itemId ?? 'Item'}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Received</div>
          <div className="text-sm font-medium text-slate-900">
            {line.quantityReceived} {line.uom}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500">QC Status</div>
          <div className="text-sm">
            {line.qcSummary?.breakdown && (
              <span className="text-xs">
                ✓{line.qcSummary.breakdown.accept}
                {line.qcSummary.breakdown.hold > 0 && ` ⚠${line.qcSummary.breakdown.hold}`}
                {line.qcSummary.breakdown.reject > 0 && ` ✗${line.qcSummary.breakdown.reject}`}
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Progress</div>
          <div className="w-full bg-slate-200 rounded-full h-2 mt-1">
            <div
              className="bg-green-600 h-2 rounded-full"
              style={{ width: `${line.qcSummary?.percentComplete ?? 0}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  )
})

QcLineItem.displayName = 'QcLineItem'

type VirtualQcLineListProps = {
  lines: PurchaseOrderReceiptLine[]
  activeLineId: string | null
  selectedLineIds: Set<string>
  onSelectLine: (lineId: string) => void
  onClickLine: (lineId: string) => void
  height?: number
  itemHeight?: number
}

export function VirtualQcLineList({
  lines,
  activeLineId,
  selectedLineIds,
  onSelectLine,
  onClickLine,
  height = 600,
  itemHeight = 80,
}: VirtualQcLineListProps) {
  const Row = useCallback(
    ({ index, style }: { index: number; style: React.CSSProperties }) => {
      const line = lines[index]
      if (!line) return null

      return (
        <div style={style}>
          <QcLineItem
            line={line}
            isActive={line.id === activeLineId}
            isSelected={selectedLineIds.has(line.id)}
            onSelect={onSelectLine}
            onClick={onClickLine}
          />
        </div>
      )
    },
    [lines, activeLineId, selectedLineIds, onSelectLine, onClickLine],
  )

  if (lines.length === 0) {
    return (
      <div className="text-center py-8 text-slate-500">
        <p>No receipt lines to display</p>
      </div>
    )
  }

  return (
    <List
      height={height}
      itemCount={lines.length}
      itemSize={itemHeight}
      width="100%"
      className="scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-slate-100"
    >
      {Row}
    </List>
  )
}
