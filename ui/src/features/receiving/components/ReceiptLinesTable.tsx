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
            const receivedQty = line.receivedQty === '' ? 0 : Number(line.receivedQty)
            const delta = receivedQty - expectedQty
            const hasVariance = delta !== 0
            const isMatch = delta === 0 && receivedQty > 0
            
            return (
              <div className="space-y-1">
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
                  className={`${
                    isMatch
                      ? 'border-green-300 bg-green-50 focus:border-green-500 focus:ring-green-500'
                      : hasVariance
                        ? 'border-amber-300 bg-amber-50 focus:border-amber-500 focus:ring-amber-500'
                        : ''
                  }`}
                />
                {hasVariance && (
                  <div className={`text-xs font-medium ${delta > 0 ? 'text-amber-700' : 'text-amber-700'}`}>
                    {delta > 0 ? `+${delta}` : delta} {line.uom}
                  </div>
                )}
              </div>
            )
          },
        },
        {
          id: 'unitCost',
          header: 'Unit Cost',
          cell: (line) => (
            <Input
              type="number"
              step="0.01"
              min="0"
              value={line.unitCost ?? ''}
              onChange={(e) =>
                onLineChange(line.purchaseOrderLineId, {
                  unitCost: e.target.value === '' ? '' : Number(e.target.value),
                })
              }
              placeholder="0.00"
            />
          ),
          cellClassName: 'font-mono',
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
                  className={`w-full rounded-lg border px-2 py-1.5 text-sm transition-colors ${
                    needsReason 
                      ? 'border-amber-400 bg-amber-50 ring-2 ring-amber-200' 
                      : 'border-slate-200 bg-white'
                  }`}
                  value={line.discrepancyReason}
                  onChange={(e) =>
                    onLineChange(line.purchaseOrderLineId, {
                      discrepancyReason: e.target.value as ReceiptLineInput['discrepancyReason'],
                    })
                  }
                >
                  <option value="">— Select reason —</option>
                  <option value="short">Short</option>
                  <option value="over">Over</option>
                  <option value="damaged">Damaged</option>
                  <option value="substituted">Substituted</option>
                </select>
                {needsReason && (
                  <div className="text-xs text-amber-700">⚠️ Reason required</div>
                )}
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
              <span className="text-xs text-slate-500">—</span>
            )
          },
        },
      ]}
    />
  )
}
