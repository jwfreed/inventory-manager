import { lazy, Suspense, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Badge, Button, Card, DataTable, Section } from '@shared/ui'
import { formatNumber } from '@shared/formatters'
import { DraggablePutawayLinesEditor } from '../components/DraggablePutawayLinesEditor'
import { PutawaySummaryTable } from '../components/PutawaySummaryTable'
import { ReceiptDocument } from '../components/ReceiptDocument'
import { KeyboardHint } from '../components/KeyboardHint'
import { ReceivingLayout } from '../components/ReceivingLayout'
import { useReceivingContext } from '../context'
import { useResponsive } from '../hooks/useResponsive'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { useAuth } from '@shared/auth'

const KeyboardShortcutsModal = lazy(() => import('../components/KeyboardShortcutsModal'))

export default function PutawayPlanningPage() {
  const ctx = useReceivingContext()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { isMobile } = useResponsive()
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false)

  const putaway = ctx.putawayQuery.data ?? ctx.postPutawayMutation.data
  const receipt = ctx.receiptQuery.data
  const isCompleted = putaway?.status === 'completed'
  const showDraftForm = !isCompleted && (!ctx.putawayId || (ctx.putawayQuery.data && ['draft', 'in_progress'].includes(ctx.putawayQuery.data.status)))

  const summary = useMemo(() => {
    const lines = putaway?.lines ?? []
    const totalPlaced = lines.reduce((sum, line) => sum + (line.quantityMoved ?? line.quantityPlanned ?? 0), 0)
    const itemIds = new Set(lines.map((line) => line.itemId))
    const itemCount = itemIds.size
    const firstLine = lines[0]
    const label = firstLine ? (firstLine.itemSku || firstLine.itemName || 'Item') : 'Item'
    const uom = firstLine?.uom ?? 'units'
    if (itemCount <= 1 && firstLine) {
      return `${formatNumber(totalPlaced)} ${uom} of ${label} has been placed into storage.`
    }
    return `${itemCount} items · ${formatNumber(totalPlaced)} units placed into storage.`
  }, [putaway?.lines])

  const exceptionNotes = useMemo(() => {
    if (!receipt?.lines?.length) return []
    const notes: string[] = []
    receipt.lines.forEach((line) => {
      if (line.discrepancyReason && line.expectedQuantity !== undefined) {
        const delta = (line.quantityReceived ?? 0) - (line.expectedQuantity ?? 0)
        if (delta !== 0) {
          const direction = delta > 0 ? 'Over-received' : 'Short received'
          notes.push(`${direction}: ${formatNumber(Math.abs(delta))} ${line.uom} ${line.itemSku || line.itemName || ''}`.trim())
        }
      }
      const qc = line.qcSummary?.breakdown
      if (qc?.hold && qc.hold > 0) {
        notes.push(`QC hold: ${formatNumber(qc.hold)} ${line.uom} ${line.itemSku || line.itemName || ''}`.trim())
      }
      if (qc?.reject && qc.reject > 0) {
        notes.push(`QC rejected: ${formatNumber(qc.reject)} ${line.uom} ${line.itemSku || line.itemName || ''}`.trim())
      }
    })
    return notes
  }, [receipt?.lines])

  const isPartialReceipt = useMemo(() => {
    if (!receipt?.lines?.length) return false
    return receipt.lines.some((line) => (line.quantityReceived ?? 0) < (line.expectedQuantity ?? 0))
  }, [receipt?.lines])

  // Keyboard shortcuts
  useKeyboardShortcuts([
    {
      key: 's',
      ctrl: true,
      handler: () => {
        if (!ctx.putawayId && ctx.canCreatePutaway && !ctx.putawayMutation.isPending) {
          // Trigger form submission
          const formElement = document.querySelector('form[data-putaway-form]') as HTMLFormElement
          if (formElement) {
            formElement.requestSubmit()
          }
        }
      },
      preventDefault: true,
    },
    {
      key: 'p',
      ctrl: true,
      handler: () => {
        if (ctx.putawayId && ctx.putawayLines.length > 0 && !ctx.postPutawayMutation.isPending) {
          ctx.postPutawayMutation.mutate(ctx.putawayId)
        }
      },
      preventDefault: true,
    },
    {
      key: '?',
      shift: true,
      handler: () => setShowShortcutsHelp(true),
    },
  ], { enabled: !isCompleted })

  useKeyboardShortcuts(
    [
      {
        key: 'enter',
        handler: () => navigate('/receiving'),
        preventDefault: true,
      },
      {
        key: 'escape',
        handler: () => navigate('/receiving'),
        preventDefault: true,
      },
    ],
    { enabled: isCompleted }
  )

  return (
    <ReceivingLayout>
      <Section
        title="Plan putaway"
        description="Define putaway destinations for accepted inventory."
      >
        <Card>
          {isCompleted && putaway ? (
            <div className="space-y-6">
              <div
                className="flex flex-col items-center justify-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-6 py-8 text-center"
                role="status"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                  ✓
                </div>
                <div>
                  <h3 className="text-xl font-semibold text-emerald-900">Putaway complete</h3>
                  <p className="text-sm text-emerald-700">
                    Inventory has been successfully stored and is now available.
                  </p>
                </div>
              </div>

              <div className="grid gap-4 rounded-lg border border-slate-200 bg-white p-4 text-sm sm:grid-cols-2">
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">PO</div>
                  <div className="font-medium text-slate-900">
                    {receipt?.purchaseOrderNumber || putaway.purchaseOrderNumber || 'Unassigned'}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Receipt</div>
                  <div className="font-medium text-slate-900">
                    {receipt?.receiptNumber || putaway.receiptNumber || 'Unassigned'}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Putaway</div>
                  <div className="font-medium text-slate-900">
                    {putaway.putawayNumber || 'Unassigned'}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Completed by</div>
                  <div className="font-medium text-slate-900">
                    {putaway.completedByName || putaway.completedByEmail || user?.fullName || user?.email || 'Unknown'}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Completed at</div>
                  <div className="font-medium text-slate-900">
                    {putaway.completedAt ? new Date(putaway.completedAt).toLocaleString() : '—'}
                  </div>
                </div>
                {isPartialReceipt && (
                  <div>
                    <div className="text-xs uppercase tracking-wide text-slate-500">Status</div>
                    <div className="font-medium text-slate-900">
                      Partially received (backorder created)
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                {summary}
              </div>

              <div>
                <div className="mb-2 text-sm font-semibold text-slate-700">Putaway details</div>
                <DataTable
                  rows={putaway.lines}
                  rowKey={(line) => line.id}
                  stickyHeader
                  containerClassName="max-h-[360px] overflow-auto"
                  columns={[
                    {
                      id: 'item',
                      header: 'Item',
                      cell: (line) => (
                        <div>
                          <div className="text-sm font-medium text-slate-900">
                            {line.itemSku || line.itemName || 'Item'}
                          </div>
                          {line.itemName && line.itemSku && (
                            <div className="text-xs text-slate-500">{line.itemName}</div>
                          )}
                        </div>
                      ),
                    },
                    {
                      id: 'qty',
                      header: 'Quantity',
                      cell: (line) =>
                        `${formatNumber(line.quantityMoved ?? line.quantityPlanned ?? 0)} ${line.uom}`,
                      cellClassName: 'text-right',
                    },
                    {
                      id: 'location',
                      header: 'Storage location',
                      cell: (line) => (
                        <div className="font-mono text-xs text-slate-700">
                          {line.toLocationCode || line.toLocationName || 'Unassigned'}
                        </div>
                      ),
                    },
                    {
                      id: 'status',
                      header: 'Status',
                      cell: (line) => {
                        if (line.putawayBlockedReason) return 'Blocked'
                        if (line.qcBreakdown?.hold && line.qcBreakdown.hold > 0) return 'QC Hold'
                        return 'Available'
                      },
                    },
                  ]}
                />
              </div>

              {exceptionNotes.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <div className="font-semibold">Exceptions & notes</div>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {exceptionNotes.map((note, idx) => (
                      <li key={`${note}-${idx}`}>{note}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
                🔒 Putaway is complete and can no longer be edited.
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <Button onClick={() => navigate('/receiving')}>Back to receiving queue</Button>
                <div className="flex flex-wrap gap-2">
                  {receipt?.id && (
                    <Button variant="secondary" onClick={() => navigate(`/receipts/${receipt.id}`)}>
                      View receipt
                    </Button>
                  )}
                  {receipt?.purchaseOrderId && (
                    <Button variant="secondary" onClick={() => navigate(`/purchase-orders/${receipt.purchaseOrderId}`)}>
                      View purchase order
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    onClick={() =>
                      putaway.inventoryMovementId
                        ? navigate(`/movements/${putaway.inventoryMovementId}`)
                        : navigate('/movements')
                    }
                  >
                    View movement log
                  </Button>
                </div>
              </div>
            </div>
          ) : !ctx.putawayReady ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="text-slate-400 mb-4">
                <svg className="w-16 h-16 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-slate-900 mb-2">Putaway not available</h3>
              <p className="text-sm text-slate-600 max-w-sm">
                {!ctx.receiptQuery.data
                  ? 'Load a receipt and complete QC classification first.'
                  : ctx.putawayBlockingLine
                    ? `Line has QC hold with no accepted quantity. Resolve QC before planning putaway.`
                    : !ctx.putawayHasAvailable
                      ? 'No quantities available for putaway. Complete QC classification to accept inventory.'
                      : 'Putaway prerequisites not met.'}
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Receipt Document */}
              {ctx.receiptQuery.data && (
                <ReceiptDocument receipt={ctx.receiptQuery.data} showQcStatus={true} />
              )}

              {/* Draft Putaway Form */}
              {showDraftForm && (
                <form onSubmit={ctx.onCreatePutaway} className="space-y-4" data-putaway-form>
                  <div>
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-0 mb-3">
                      <h4 className="text-sm font-medium text-slate-700">Putaway lines</h4>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={ctx.fillPutawayFromReceipt}
                        disabled={ctx.putawayMutation.isPending}
                        className="w-full sm:w-auto"
                      >
                        <span className="hidden sm:inline">Fill from receipt</span>
                        <span className="sm:hidden">Auto-fill</span>
                      </Button>
                    </div>
                    <DraggablePutawayLinesEditor
                      lines={ctx.putawayLines}
                      receiptLineOptions={ctx.receiptLineOptions}
                      locationOptions={ctx.locationOptions}
                      locationsLoading={ctx.locationsQuery.isLoading}
                      onLocationSearch={ctx.setLocationSearch}
                      onLineChange={(index, patch) => {
                        ctx.setPutawayLines((prev) => {
                          const updated = [...prev]
                          updated[index] = { ...updated[index], ...patch }
                          return updated
                        })
                      }}
                      onReorderLines={(startIndex, endIndex) => {
                        ctx.setPutawayLines((prev) => {
                          const updated = [...prev]
                          const [removed] = updated.splice(startIndex, 1)
                          updated.splice(endIndex, 0, removed)
                          return updated
                        })
                      }}
                      onRemoveLine={(index) => {
                        ctx.setPutawayLines((prev) => prev.filter((_, i) => i !== index))
                      }}
                      resolvePutawayDefaults={ctx.resolvePutawayDefaults}
                    />
                  </div>

                  {/* Notices */}
                  {ctx.putawayFillNotice && (
                    <Alert variant="info" message={ctx.putawayFillNotice} />
                  )}

                  {ctx.putawayResumeNotice && (
                    <Alert variant="info" message={ctx.putawayResumeNotice} />
                  )}

                  {/* Validation Issues */}
                  {ctx.putawayQcIssues.length > 0 && (
                    <Alert
                      variant="warning"
                      title="QC issues detected"
                      message={ctx.putawayQcIssues.map((issue) => `Line ${issue.idx + 1} (${issue.label}): ${issue.reason}`).join('; ')}
                    />
                  )}

                  {ctx.putawayQuantityIssues.length > 0 && (
                    <Alert
                      variant="warning"
                      title="Quantity issues detected"
                      message={ctx.putawayQuantityIssues.map((issue) => `Line ${issue.idx + 1} (${issue.label}): Requested quantity exceeds available ${issue.availableQty}`).join('; ')}
                    />
                  )}

                  {/* Submit */}
                  {!ctx.putawayId && (
                    <div className="flex items-center justify-end pt-4 border-t border-slate-200">
                      <Button
                        type="submit"
                        disabled={!ctx.canCreatePutaway || ctx.putawayMutation.isPending}
                        className="w-full sm:w-auto"
                      >
                        {ctx.putawayMutation.isPending ? 'Creating…' : isMobile ? 'Create putaway' : 'Create draft putaway'} <KeyboardHint shortcut="Ctrl+S" />
                      </Button>
                    </div>
                  )}

                  {/* Mutation Feedback */}
                  {ctx.putawayMutation.isError && (
                    <Alert
                      variant="error"
                      title="Putaway creation failed"
                      message={ctx.getErrorMessage(ctx.putawayMutation.error, 'Failed to create putaway')}
                    />
                  )}

                  {ctx.putawayMutation.isSuccess && !ctx.putawayId && (
                    <Alert
                      variant="success"
                      title="Draft putaway created!"
                      message={`ID: ${ctx.putawayMutation.data?.id}`}
                    />
                  )}
                </form>
              )}

              {/* Existing Putaway Summary */}
              {ctx.putawayId && ctx.putawayQuery.data && (
                <div className="space-y-6">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-4 border-b border-slate-200">
                    <div>
                      <h3 className="text-lg font-semibold text-slate-900">
                        Putaway #{ctx.putawayQuery.data.id}
                      </h3>
                      <p className="text-sm text-slate-600">
                        {ctx.putawayQuery.data.lines?.length ?? 0} lines
                      </p>
                    </div>
                    <Badge
                      variant={
                        ctx.putawayQuery.data.status === 'completed'
                          ? 'success'
                          : ctx.putawayQuery.data.status === 'canceled'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {ctx.putawayQuery.data.status}
                    </Badge>
                  </div>

                  <PutawaySummaryTable putaway={ctx.putawayQuery.data} />

                  {/* Post Putaway */}
                  {['draft', 'in_progress'].includes(ctx.putawayQuery.data.status) && (
                    <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
                      <Button
                        onClick={() => ctx.postPutawayMutation.mutate(ctx.putawayId)}
                        disabled={ctx.putawayLines.length === 0 || ctx.postPutawayMutation.isPending}
                        className="w-full sm:w-auto"
                      >
                        {ctx.postPutawayMutation.isPending ? 'Posting…' : 'Post putaway'} <KeyboardHint shortcut="Ctrl+P" />
                      </Button>
                    </div>
                  )}

                  {/* Post Mutation Feedback */}
                  {ctx.postPutawayMutation.isError && (
                    <Alert
                      variant="error"
                      title="Putaway posting failed"
                      message={ctx.getErrorMessage(ctx.postPutawayMutation.error, 'Failed to post putaway')}
                    />
                  )}

                  {ctx.postPutawayMutation.isSuccess && (
                    <Alert
                      variant="success"
                      title="Putaway posted successfully!"
                      message="Inventory has been moved to the specified locations."
                      action={
                        <Button
                          size="sm"
                          onClick={() => {
                            ctx.setSelectedPoId('')
                            ctx.setReceiptIdForQc('')
                            ctx.setPutawayId('')
                            ctx.updateReceivingParams({ receiptId: '', putawayId: '' })
                          }}
                        >
                          Start new receipt →
                        </Button>
                      }
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Keyboard Shortcuts Help Button */}
        <div className="flex justify-end mt-4">
          <button
            onClick={() => setShowShortcutsHelp(true)}
            className="text-sm text-slate-600 hover:text-slate-900 flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Keyboard shortcuts
            <KeyboardHint shortcut="?" />
          </button>
        </div>
      </Section>

      {/* Keyboard Shortcuts Help Modal */}
      {showShortcutsHelp && (
        <Suspense fallback={null}>
          <KeyboardShortcutsModal onClose={() => setShowShortcutsHelp(false)} />
        </Suspense>
      )}
    </ReceivingLayout>
  )
}
