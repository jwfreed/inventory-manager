import { lazy, Suspense, useState } from 'react'
import { Alert, Badge, Button, Card, Section } from '@shared/ui'
import { DraggablePutawayLinesEditor } from '../components/DraggablePutawayLinesEditor'
import { PutawaySummaryTable } from '../components/PutawaySummaryTable'
import { ReceiptDocument } from '../components/ReceiptDocument'
import { KeyboardHint } from '../components/KeyboardHint'
import { ReceivingLayout } from '../components/ReceivingLayout'
import { useReceivingContext } from '../context'
import { useResponsive } from '../hooks/useResponsive'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'

const KeyboardShortcutsModal = lazy(() => import('../components/KeyboardShortcutsModal'))

export default function PutawayPlanningPage() {
  const ctx = useReceivingContext()
  const { isMobile } = useResponsive()
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false)

  const showDraftForm = !ctx.putawayId || (ctx.putawayQuery.data && ['draft', 'in_progress'].includes(ctx.putawayQuery.data.status))

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
  ])

  return (
    <ReceivingLayout>
      <Section
        title="Plan putaway"
        description="Define putaway destinations for accepted inventory."
      >
        <Card>
          {!ctx.putawayReady ? (
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
