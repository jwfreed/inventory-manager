import { memo, useMemo, type CSSProperties, type ReactElement } from 'react'
import { List } from 'react-window'
import type { PurchaseOrderReceiptLine } from '@api/types'

type QcLineItemProps = {
  line: PurchaseOrderReceiptLine
  isActive: boolean
  isSelected: boolean
  onSelect: (lineId: string) => void
  onClick: (lineId: string) => void
}

function calculatePercentComplete(qcSummary: PurchaseOrderReceiptLine['qcSummary']): number {
  if (!qcSummary) return 0
  const total = qcSummary.totalQcQuantity
  if (total === 0) return 0
  const processed = total - qcSummary.remainingUninspectedQuantity
  return Math.round((processed / total) * 100)
}

const QcLineItem = memo(({ line, isActive, isSelected, onSelect, onClick }: QcLineItemProps) => {
  const percentComplete = calculatePercentComplete(line.qcSummary)

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
              style={{ width: `${percentComplete}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  )
})

QcLineItem.displayName = 'QcLineItem'

type RowProps = {
  lines: PurchaseOrderReceiptLine[]
  activeLineId: string | null
  selectedLineIds: Set<string>
  onSelectLine: (lineId: string) => void
  onClickLine: (lineId: string) => void
}

function QcRow({ index, style, lines, activeLineId, selectedLineIds, onSelectLine, onClickLine }: {
  index: number
  style: CSSProperties
  ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' }
} & RowProps): ReactElement {
  const line = lines[index]
  if (!line) return <div style={style} />

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
}

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
  const rowProps = useMemo(
    () => ({
      lines,
      activeLineId,
      selectedLineIds,
      onSelectLine,
      onClickLine,
    }),
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
      style={{ height, width: '100%' }}
      rowCount={lines.length}
      rowHeight={itemHeight}
      rowComponent={QcRow}
      rowProps={rowProps}
      className="scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-slate-100"
    />
  )
}
