import type { ReceiptLineInput } from '../types'
import { DataTable, Input } from '@shared/ui'

type Props = {
  lines: ReceiptLineInput[]
  onLineChange: (lineId: string, patch: Partial<ReceiptLineInput>) => void
  emptyMessage?: string
}

export function ReceiptLinesTable({ lines, onLineChange, emptyMessage }: Props) {
  return (
    <DataTable
      rows={lines}
      rowKey={(line) => line.purchaseOrderLineId}
      emptyMessage={emptyMessage}
      columns={[
        {
          id: 'line',
          header: 'Line',
          cell: (line) => line.lineNumber,
          cellClassName: 'font-mono text-xs text-slate-600',
        },
        {
          id: 'item',
          header: 'Item',
          cell: (line) => line.itemLabel,
        },
        {
          id: 'expected',
          header: 'Expected',
          cell: (line) => `${line.expectedQty} ${line.uom}`,
        },
        {
          id: 'received',
          header: 'Received',
          cell: (line) => {
            const expectedQty = line.expectedQty ?? 0
            return (
              <Input
                type="number"
                min={0}
                value={line.receivedQty}
                onChange={(e) => {
                  const nextValue = e.target.value === '' ? '' : Number(e.target.value)
                  const nextReceived = nextValue === '' ? 0 : Number(nextValue)
                  const nextDelta = nextReceived - expectedQty
                  let nextReason = line.discrepancyReason
                  let nextNotes = line.discrepancyNotes
                  if (nextDelta === 0) {
                    nextReason = ''
                    nextNotes = ''
                  } else if (!nextReason) {
                    nextReason = nextDelta > 0 ? 'over' : 'short'
                  }
                  onLineChange(line.purchaseOrderLineId, {
                    receivedQty: nextValue,
                    discrepancyReason: nextReason,
                    discrepancyNotes: nextNotes,
                  })
                }}
              />
            )
          },
        },
        {
          id: 'delta',
          header: 'Delta',
          cell: (line) => {
            const receivedQty = line.receivedQty === '' ? 0 : Number(line.receivedQty)
            const expectedQty = line.expectedQty ?? 0
            const delta = receivedQty - expectedQty
            const hasVariance = delta !== 0
            const deltaLabel = hasVariance
              ? delta > 0
                ? `Over by ${delta}`
                : `Short by ${Math.abs(delta)}`
              : 'On target'
            const deltaTone = hasVariance ? 'text-amber-700' : 'text-slate-500'
            return <span className={deltaTone}>{deltaLabel}</span>
          },
        },
        {
          id: 'discrepancy',
          header: 'Discrepancy',
          cell: (line) => {
            const receivedQty = line.receivedQty === '' ? 0 : Number(line.receivedQty)
            const expectedQty = line.expectedQty ?? 0
            const delta = receivedQty - expectedQty
            const hasVariance = delta !== 0
            const needsReason = hasVariance && !line.discrepancyReason
            return hasVariance ? (
              <div className="space-y-1">
                <select
                  className={`w-full rounded-lg border px-2 py-1 text-sm ${
                    needsReason ? 'border-amber-300 bg-amber-50' : 'border-slate-200'
                  }`}
                  value={line.discrepancyReason}
                  onChange={(e) =>
                    onLineChange(line.purchaseOrderLineId, {
                      discrepancyReason: e.target.value as ReceiptLineInput['discrepancyReason'],
                    })
                  }
                >
                  <option value="">Select reason</option>
                  <option value="short">Short</option>
                  <option value="over">Over</option>
                  <option value="damaged">Damaged</option>
                  <option value="substituted">Substituted</option>
                </select>
                {(line.discrepancyReason === 'damaged' || line.discrepancyReason === 'substituted') && (
                  <Input
                    value={line.discrepancyNotes}
                    onChange={(e) =>
                      onLineChange(line.purchaseOrderLineId, {
                        discrepancyNotes: e.target.value,
                      })
                    }
                    placeholder="Notes (optional)"
                  />
                )}
              </div>
            ) : (
              <span className="text-xs text-slate-500">No variance</span>
            )
          },
        },
      ]}
    />
  )
}
