import { lazy, Suspense, useState } from 'react'
import { Alert, Button, Card, Combobox, Section, Textarea } from '@shared/ui'
import { ReceiptLinesTable } from '../components/ReceiptLinesTable'
import { WorkflowProgressChart } from '../components/WorkflowProgressChart'
import { KeyboardHint } from '../components/KeyboardHint'
import { ReceivingLayout } from '../components/ReceivingLayout'
import { useReceivingContext } from '../context'
import { useResponsive } from '../hooks/useResponsive'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'

const KeyboardShortcutsModal = lazy(() => import('../components/KeyboardShortcutsModal'))

export default function ReceiptCapturePage() {
  const ctx = useReceivingContext()
  const { isMobile } = useResponsive()
  const [showSidebar, setShowSidebar] = useState(false)
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false)

  // Keyboard shortcuts
  useKeyboardShortcuts([
    {
      key: 's',
      ctrl: true,
      handler: () => {
        if (ctx.canPostReceipt && !ctx.receiptMutation.isPending) {
          // Trigger form submission
          const formElement = document.querySelector('form[data-receipt-form]') as HTMLFormElement
          if (formElement) {
            formElement.requestSubmit()
          }
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
      <div className={`grid gap-6 ${isMobile ? 'grid-cols-1' : 'lg:grid-cols-[minmax(0,1fr)_320px]'}`}>
        {/* Main Content */}
        <div className={`space-y-6 ${isMobile && showSidebar ? 'hidden' : 'block'}`}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Inbound</p>
              <h2 className="text-2xl font-semibold text-slate-900">Receive Goods</h2>
            </div>

            {isMobile && (
              <button
                onClick={() => setShowSidebar(!showSidebar)}
                className="lg:hidden p-2 rounded-lg hover:bg-slate-100 transition-colors"
              >
                <svg className="w-6 h-6 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            )}
          </div>

          <Section
            title="Confirm receipt"
            description="Select a purchase order and verify received quantities."
          >
            <Card>
              <form className="space-y-4" onSubmit={ctx.onCreateReceipt} data-receipt-form>
                {/* PO Selection */}
                <div className="rounded-lg border border-slate-200 p-4 space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Purchase order
                    </label>
                    <select
                      value={ctx.selectedPoId}
                      onChange={(e) => ctx.handlePoChange(e.target.value)}
                      disabled={ctx.receiptMutation.isPending}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-slate-50 disabled:text-slate-500"
                    >
                      <option value="">Select PO…</option>
                      {ctx.poOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {ctx.poQuery.data && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                      <div>
                        <span className="text-slate-500">Vendor:</span>{' '}
                        <span className="font-medium text-slate-900">{ctx.poQuery.data.vendorId}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Status:</span>{' '}
                        <span className="font-medium text-slate-900">{ctx.poQuery.data.status}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Expected:</span>{' '}
                        <span className="font-medium text-slate-900">{ctx.poQuery.data.expectedDate ?? 'N/A'}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Ship to:</span>{' '}
                        <span className="font-medium text-slate-900">{ctx.poQuery.data.shipToLocationId}</span>
                      </div>
                    </div>
                  )}
                </div>

                {ctx.selectedPoId && ctx.poQuery.data && (
                  <>
                    {/* Receiving Location */}
                    <div>
                      <Combobox
                        label="Receiving location"
                        placeholder="Select location…"
                        options={ctx.locationOptions}
                        value={ctx.resolvedReceivedToLocationId}
                        onChange={(val) => ctx.setReceivedToLocationId(val)}
                        disabled={ctx.receiptMutation.isPending}
                      />
                      <p className="mt-1 text-xs text-slate-500">
                        Where incoming goods will be staged after receipt
                      </p>
                    </div>

                    {/* Receipt Lines */}
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Receipt lines{' '}
                        <span className="text-slate-500">
                          ({ctx.receiptLineSummary.lines.length} lines)
                        </span>
                      </label>
                      <ReceiptLinesTable
                        lines={ctx.receiptLineInputs}
                        onLineChange={(lineId, patch) => {
                          ctx.setReceiptLineInputs((prev) => {
                            if (!prev) return prev
                            return prev.map((line) =>
                              line.purchaseOrderLineId === lineId ? { ...line, ...patch } : line
                            )
                          })
                        }}
                      />
                    </div>

                    {/* Discrepancy Alert */}
                    {ctx.receiptLineSummary.discrepancyLines.length > 0 && (
                      <Alert
                        variant="warning"
                        title="Discrepancies detected"
                        message={`${ctx.receiptLineSummary.discrepancyLines.length} line(s) have quantity variances.${ctx.receiptLineSummary.missingReasons.length > 0 ? ` Reason required for ${ctx.receiptLineSummary.missingReasons.length} line(s).` : ''}`}
                      />
                    )}

                    {/* Notes */}
                    <div>
                      <label htmlFor="receipt-notes" className="block text-sm font-medium text-slate-700 mb-1">
                        Notes <span className="text-slate-500">(optional)</span>
                      </label>
                      <Textarea
                        id="receipt-notes"
                        value={ctx.receiptNotes}
                        onChange={(e) => ctx.setReceiptNotes(e.target.value)}
                        placeholder="Add notes about this receipt (damaged packaging, early delivery, etc.)…"
                        rows={3}
                        disabled={ctx.receiptMutation.isPending}
                      />
                    </div>

                    {/* Summary and Submit */}
                    <div className="flex items-center justify-between pt-4 border-t border-slate-200">
                      <div className="text-sm text-slate-600">
                        <span className="font-medium">{ctx.receiptLineSummary.totalReceived}</span> of{' '}
                        <span className="font-medium">{ctx.receiptLineSummary.totalExpected}</span> expected{' '}
                        {ctx.receiptLineSummary.discrepancyLines.length > 0 && (
                          <span className="text-amber-600">· {ctx.receiptLineSummary.discrepancyLines.length} discrepancies</span>
                        )}
                      </div>
                      <Button
                        type="submit"
                        disabled={!ctx.canPostReceipt || ctx.receiptMutation.isPending}
                      >
                        {ctx.receiptMutation.isPending ? 'Posting…' : 'Post receipt'} <KeyboardHint shortcut="Ctrl+S" />
                      </Button>
                    </div>

                    {/* Error Message */}
                    {ctx.receiptMutation.isError && (
                      <Alert
                        variant="error"
                        title="Receipt creation failed"
                        message={ctx.getErrorMessage(ctx.receiptMutation.error, 'Failed to create receipt')}
                      />
                    )}

                    {/* Success Message */}
                    {ctx.receiptMutation.isSuccess && (
                      <Alert
                        variant="success"
                        title="Receipt posted successfully!"
                        message={`Receipt #${ctx.receiptMutation.data?.id}`}
                        action={
                          <Button
                            size="sm"
                            onClick={() => {
                              if (ctx.receiptMutation.data?.id) {
                                ctx.updateReceivingParams({ receiptId: ctx.receiptMutation.data.id })
                              }
                            }}
                          >
                            Proceed to QC →
                          </Button>
                        }
                      />
                    )}
                  </>
                )}
              </form>
            </Card>
          </Section>

          {/* Keyboard Shortcuts Help Button */}
          <div className="flex justify-end">
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
        </div>

        {/* Sidebar */}
        <aside className={`space-y-6 ${isMobile && !showSidebar ? 'hidden' : 'block'}`}>
          {isMobile && (
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-slate-900">Workflow Progress</h3>
              <button
                onClick={() => setShowSidebar(false)}
                className="p-2 rounded-lg hover:bg-slate-100 transition-colors"
              >
                <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
              </button>
            </div>
          )}

          <WorkflowProgressChart
            currentStageId="receipt"
            stages={[
              {
                id: 'receipt',
                label: 'Receipt Capture',
                complete: false,
                stats: [
                  {
                    label: 'Lines processed',
                    value: `${ctx.receiptLineSummary.lines.length} of ${ctx.poQuery.data?.lines?.length ?? 0}`,
                  },
                ],
              },
              {
                id: 'qc',
                label: 'QC Classification',
                complete: false,
              },
              {
                id: 'putaway',
                label: 'Putaway Planning',
                complete: false,
              },
            ]}
          />
        </aside>
      </div>

      {/* Keyboard Shortcuts Help Modal */}
      {showShortcutsHelp && (
        <Suspense fallback={null}>
          <KeyboardShortcutsModal onClose={() => setShowShortcutsHelp(false)} />
        </Suspense>
      )}
    </ReceivingLayout>
  )
}
