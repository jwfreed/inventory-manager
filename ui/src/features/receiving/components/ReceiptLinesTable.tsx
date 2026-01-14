import { useEffect, useMemo, useRef } from 'react'
import type { ReceiptLineInput } from '../types'
import { DataTable, Input, Textarea } from '@shared/ui'
import { cn } from '../../../lib/utils'

type Props = {
  lines: ReceiptLineInput[]
  onLineChange: (lineId: string, patch: Partial<ReceiptLineInput>) => void
  emptyMessage?: string
  focusLineId?: string | null
  onFocusLineHandled?: () => void
  disabled?: boolean
}

export function ReceiptLinesTable({
  lines,
  onLineChange,
  emptyMessage,
  focusLineId,
  onFocusLineHandled,
  disabled = false,
}: Props) {
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const reasonRefs = useRef<Record<string, HTMLSelectElement | null>>({})
  const lotRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const serialRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const notesRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const approvalRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const focusTarget = useMemo(() => focusLineId, [focusLineId])
  const lineOrder = useMemo(() => lines.map((line) => line.purchaseOrderLineId), [lines])

  useEffect(() => {
    if (!focusTarget) return
    const line = lines.find((row) => row.purchaseOrderLineId === focusTarget)
    if (line) {
      const receivedQty = line.receivedQty === '' ? 0 : Number(line.receivedQty)
      const expectedQty = line.expectedQty ?? 0
      const delta = receivedQty - expectedQty
      const needsReason = delta !== 0 && !line.discrepancyReason
      const needsLot = line.requiresLot && receivedQty > 0 && !(line.lotCode ?? '').trim()
      const needsSerial =
        line.requiresSerial &&
        receivedQty > 0 &&
        (!line.serialNumbers ||
          line.serialNumbers.length === 0 ||
          !Number.isInteger(receivedQty) ||
          line.serialNumbers.length !== receivedQty)
      if (needsReason && reasonRefs.current[focusTarget]) {
        reasonRefs.current[focusTarget]?.focus()
        onFocusLineHandled?.()
        return
      }
      if (needsLot && lotRefs.current[focusTarget]) {
        lotRefs.current[focusTarget]?.focus()
        onFocusLineHandled?.()
        return
      }
      if (needsSerial && serialRefs.current[focusTarget]) {
        serialRefs.current[focusTarget]?.focus()
        onFocusLineHandled?.()
        return
      }
    }
    const targetRef = inputRefs.current[focusTarget]
    if (targetRef) {
      targetRef.focus()
      targetRef.select()
      onFocusLineHandled?.()
    }
  }, [focusTarget, lines, onFocusLineHandled])

  const focusNextQty = (lineId: string) => {
    const idx = lineOrder.indexOf(lineId)
    if (idx === -1) return
    const nextId = lineOrder[idx + 1]
    if (!nextId) return
    const nextRef = inputRefs.current[nextId]
    if (nextRef) {
      nextRef.focus()
      nextRef.select()
    }
  }

  const focusNotes = (lineId: string) => {
    const notesRef = notesRefs.current[lineId]
    if (notesRef) {
      notesRef.focus()
      return true
    }
    return false
  }

  const focusLotOrSerial = (lineId: string) => {
    const lotRef = lotRefs.current[lineId]
    if (lotRef) {
      lotRef.focus()
      return true
    }
    const serialRef = serialRefs.current[lineId]
    if (serialRef) {
      serialRef.focus()
      return true
    }
    return false
  }

  const handleNextAfterReason = (lineId: string) => {
    if (focusLotOrSerial(lineId)) return
    if (focusNotes(lineId)) return
    focusNextQty(lineId)
  }
  return (
    <DataTable
      rows={lines}
      rowKey={(line) => line.purchaseOrderLineId}
      emptyMessage={emptyMessage}
      stickyHeader
      containerClassName="max-h-[60vh] overflow-auto"
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
          cell: (line) => (
            <div className="space-y-1">
              <div className="text-sm text-slate-900">{line.itemLabel}</div>
              {line.requiresQc && (
                <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                  QC required
                </span>
              )}
            </div>
          ),
        },
        {
          id: 'expected',
          header: 'Expected',
          cell: (line) => (
            <div>
              <div className="text-sm text-slate-900">{line.expectedQty}</div>
              <div className="text-xs text-slate-500">{line.uom}</div>
            </div>
          ),
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
            const isInvalid = receivedQty < 0
            const hasLotError = line.requiresLot && receivedQty > 0 && !(line.lotCode ?? '').trim()
            const hasSerialError =
              line.requiresSerial &&
              receivedQty > 0 &&
              (!line.serialNumbers ||
                line.serialNumbers.length === 0 ||
                !Number.isInteger(receivedQty) ||
                line.serialNumbers.length !== receivedQty)
            const qtyErrorId = `receipt-qty-error-${line.purchaseOrderLineId}`

            return (
              <div className="space-y-1">
                <Input
                  ref={(el) => {
                    inputRefs.current[line.purchaseOrderLineId] = el
                  }}
                  type="number"
                  min={0}
                  value={line.receivedQty}
                  disabled={disabled}
                  aria-invalid={isInvalid}
                  aria-describedby={isInvalid ? qtyErrorId : undefined}
                  onChange={(e) => {
                    const nextValue = e.target.value === '' ? '' : Number(e.target.value)
                    const nextReceived = nextValue === '' ? 0 : Number(nextValue)
                    const nextDelta = nextReceived - expectedQty
                    let nextReason = line.discrepancyReason
                    let nextNotes = line.discrepancyNotes
                    if (nextDelta === 0) {
                      nextReason = ''
                      nextNotes = line.discrepancyNotes
                    } else if (!nextReason) {
                      nextReason = nextDelta > 0 ? 'over' : 'short'
                    }
                    onLineChange(line.purchaseOrderLineId, {
                      receivedQty: nextValue,
                      discrepancyReason: nextReason,
                      discrepancyNotes: nextNotes,
                    })
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    if (hasVariance && reasonRefs.current[line.purchaseOrderLineId]) {
                      reasonRefs.current[line.purchaseOrderLineId]?.focus()
                      return
                    }
                    if ((hasLotError || hasSerialError) && focusLotOrSerial(line.purchaseOrderLineId)) return
                    focusNextQty(line.purchaseOrderLineId)
                  }}
                  className={cn(
                    isInvalid ? 'border-red-400 focus:border-red-500 focus:ring-red-100' : undefined,
                    isMatch
                      ? 'border-green-300 bg-green-50 focus:border-green-500 focus:ring-green-100'
                      : hasVariance
                        ? 'border-amber-300 bg-amber-50 focus:border-amber-500 focus:ring-amber-100'
                        : undefined,
                  )}
                />
                <div className="text-xs text-slate-500">{line.uom}</div>
                {isInvalid && (
                  <div id={qtyErrorId} className="text-xs text-red-600">
                    Quantity must be 0 or greater.
                  </div>
                )}
              </div>
            )
          },
        },
        {
          id: 'delta',
          header: 'Delta',
          cell: (line) => {
            const expectedQty = line.expectedQty ?? 0
            const receivedQty = line.receivedQty === '' ? 0 : Number(line.receivedQty)
            const delta = receivedQty - expectedQty
            if (receivedQty === 0 && expectedQty === 0) {
              return <span className="text-xs text-slate-500">—</span>
            }
            if (delta === 0 && receivedQty > 0) {
              return <span className="text-xs font-semibold text-green-700">Match</span>
            }
            if (delta === 0) {
              return <span className="text-xs text-slate-500">—</span>
            }
            const label = delta > 0 ? 'Over' : 'Short'
            return (
              <div className="text-xs font-semibold text-amber-700">
                {label} {delta > 0 ? `+${delta}` : delta} {line.uom}
              </div>
            )
          },
        },
        {
          id: 'remaining',
          header: 'Remaining',
          cell: (line) => {
            const receivedQty = line.receivedQty === '' ? 0 : Number(line.receivedQty)
            const remaining = Math.max(0, (line.expectedQty ?? 0) - receivedQty)
            return (
              <div className="text-sm text-slate-700">
                {remaining} {line.uom}
              </div>
            )
          },
        },
        {
          id: 'unitCost',
          header: 'Est. Unit Cost',
          cell: (line) => (
            <Input
              type="number"
              step="0.01"
              min="0"
              value={line.unitCost ?? ''}
              disabled={disabled}
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
            const tolerance = line.overReceiptTolerancePct ?? 0
            const allowed = expectedQty * (1 + tolerance)
            const needsOverApproval = delta > 0 && receivedQty - allowed > 1e-6
            const reasonErrorId = `receipt-reason-error-${line.purchaseOrderLineId}`
            return hasVariance ? (
              <div className="space-y-1">
                <select
                  ref={(el) => {
                    reasonRefs.current[line.purchaseOrderLineId] = el
                  }}
                  className={`w-full rounded-lg border px-2 py-1.5 text-sm transition-colors ${
                    needsReason 
                      ? 'border-amber-400 bg-amber-50 ring-2 ring-amber-200' 
                      : 'border-slate-200 bg-white'
                  }`}
                  value={line.discrepancyReason}
                  disabled={disabled}
                  aria-invalid={needsReason}
                  aria-describedby={needsReason ? reasonErrorId : undefined}
                  onChange={(e) =>
                    onLineChange(line.purchaseOrderLineId, {
                      discrepancyReason: e.target.value as ReceiptLineInput['discrepancyReason'],
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    if (needsOverApproval && approvalRefs.current[line.purchaseOrderLineId]) {
                      approvalRefs.current[line.purchaseOrderLineId]?.focus()
                      return
                    }
                    handleNextAfterReason(line.purchaseOrderLineId)
                  }}
                >
                  <option value="">— Select reason —</option>
                  <option value="short">Short</option>
                  <option value="over">Over</option>
                  <option value="damaged">Damaged</option>
                  <option value="substituted">Substituted</option>
                </select>
                {needsReason && (
                  <div id={reasonErrorId} className="text-xs text-amber-700">
                    Reason required.
                  </div>
                )}
                {needsOverApproval && (
                  <label className="flex items-center gap-2 text-xs text-amber-700">
                    <input
                      ref={(el) => {
                        approvalRefs.current[line.purchaseOrderLineId] = el
                      }}
                      type="checkbox"
                      checked={line.overReceiptApproved ?? false}
                      onChange={(e) =>
                        onLineChange(line.purchaseOrderLineId, { overReceiptApproved: e.target.checked })
                      }
                      disabled={disabled}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        e.preventDefault()
                        handleNextAfterReason(line.purchaseOrderLineId)
                      }}
                    />
                    Overage approved
                  </label>
                )}
                {needsOverApproval && !line.overReceiptApproved && (
                  <div className="text-xs text-amber-700">Approval required for this overage.</div>
                )}
              </div>
            ) : (
              <span className="text-xs text-slate-500">—</span>
            )
          },
        },
        {
          id: 'lotSerial',
          header: 'Lot / Serial',
          cell: (line) => {
            const receivedQty = line.receivedQty === '' ? 0 : Number(line.receivedQty)
            const lotRequired = line.requiresLot && receivedQty > 0
            const serialRequired = line.requiresSerial && receivedQty > 0
            const serialList = (line.serialNumbers ?? []).join(', ')
            const serialCountMismatch = serialRequired && (line.serialNumbers?.length ?? 0) !== receivedQty
            const serialQtyInvalid = serialRequired && !Number.isInteger(receivedQty)
            const serialDuplicate =
              serialRequired &&
              new Set(line.serialNumbers ?? []).size !== (line.serialNumbers ?? []).length
            return (
              <div className="space-y-2">
                {lotRequired && (
                  <div>
                    <Input
                      ref={(el) => {
                        lotRefs.current[line.purchaseOrderLineId] = el
                      }}
                      value={line.lotCode ?? ''}
                      disabled={disabled}
                      onChange={(e) =>
                        onLineChange(line.purchaseOrderLineId, { lotCode: e.target.value })
                      }
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        e.preventDefault()
                        if (serialRequired && serialRefs.current[line.purchaseOrderLineId]) {
                          serialRefs.current[line.purchaseOrderLineId]?.focus()
                          return
                        }
                        focusNotes(line.purchaseOrderLineId)
                      }}
                      placeholder="Lot code"
                    />
                    {!(line.lotCode ?? '').trim() && (
                      <div className="text-xs text-amber-700">Lot code required.</div>
                    )}
                  </div>
                )}
                {serialRequired && (
                  <div>
                    <Textarea
                      ref={(el) => {
                        serialRefs.current[line.purchaseOrderLineId] = el
                      }}
                      value={serialList}
                      disabled={disabled}
                      onChange={(e) => {
                        const raw = e.target.value
                        const values = raw
                          .split(',')
                          .map((val) => val.trim())
                          .filter(Boolean)
                        onLineChange(line.purchaseOrderLineId, { serialNumbers: values })
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' || e.shiftKey) return
                        e.preventDefault()
                        focusNotes(line.purchaseOrderLineId)
                      }}
                      placeholder="Serials (comma-separated)"
                      className="min-h-[64px]"
                    />
                    {serialQtyInvalid && (
                      <div className="text-xs text-amber-700">Serial-tracked qty must be a whole number.</div>
                    )}
                    {serialCountMismatch && (
                      <div className="text-xs text-amber-700">
                        Serial count must match received qty ({receivedQty}).
                      </div>
                    )}
                    {serialDuplicate && (
                      <div className="text-xs text-amber-700">Duplicate serials are not allowed.</div>
                    )}
                  </div>
                )}
                {!lotRequired && !serialRequired && <span className="text-xs text-slate-500">—</span>}
              </div>
            )
          },
        },
        {
          id: 'notes',
          header: 'Line Notes',
          cell: (line) => (
            <Textarea
              ref={(el) => {
                notesRefs.current[line.purchaseOrderLineId] = el
              }}
              value={line.discrepancyNotes}
              disabled={disabled}
              onChange={(e) =>
                onLineChange(line.purchaseOrderLineId, {
                  discrepancyNotes: e.target.value,
                })
              }
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey) return
                e.preventDefault()
                focusNextQty(line.purchaseOrderLineId)
              }}
              placeholder="Optional"
              className="min-h-[72px]"
            />
          ),
        },
      ]}
    />
  )
}
