import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, LoadingSpinner, Section } from '@shared/ui'
import { QcDetailPanel } from '../components/QcDetailPanel'
import { QcBatchQueue } from '../components/QcBatchQueue'
import { QcMetricsChart } from '../components/QcMetricsChart'
import { ReceiptDocument } from '../components/ReceiptDocument'
import { SearchFiltersBar } from '../components/SearchFiltersBar'
import { BulkOperationsBar } from '../components/BulkOperationsBar'
import { createQcBulkActions, BulkActionIcons } from '../components/bulkOperationsHelpers'
import { KeyboardHint } from '../components/KeyboardHint'
import { ReceivingLayout } from '../components/ReceivingLayout'
import { useReceivingContext } from '../context'
import { useResponsive } from '../hooks/useResponsive'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { useNavigate, useParams } from 'react-router-dom'

const KeyboardShortcutsModal = lazy(() => import('../components/KeyboardShortcutsModal'))

export default function QcClassificationPage() {
  const ctx = useReceivingContext()
  const navigate = useNavigate()
  const { isMobile } = useResponsive()
  const [showSidebar, setShowSidebar] = useState(false)
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const { receiptId } = useParams<{ receiptId?: string }>()

  useEffect(() => {
    if (receiptId && receiptId !== ctx.receiptIdForQc) {
      ctx.loadReceiptForQc(receiptId)
    }
  }, [receiptId, ctx.receiptIdForQc, ctx.loadReceiptForQc])

  const handleBulkAction = async (actionId: string) => {
    if (actionId === 'bulk-accept') {
      await ctx.bulkAcceptQcLines()
    } else if (actionId === 'bulk-hold') {
      const reason = window.prompt('Enter reason code for hold:')
      if (reason !== null) {
        const notes = window.prompt('Enter notes (optional):')
        await ctx.bulkHoldQcLines(reason, notes || '')
      }
    } else if (actionId === 'bulk-reject') {
      const reason = window.prompt('Enter reason code for rejection:')
      if (reason !== null) {
        const notes = window.prompt('Enter notes (optional):')
        await ctx.bulkRejectQcLines(reason, notes || '')
      }
    } else if (actionId === 'bulk-select-all') {
      ctx.selectAllQcLines()
    }
  }

  // Keyboard shortcuts for QC actions
  useKeyboardShortcuts([
    {
      key: 'a',
      handler: () => {
        if (ctx.selectedQcLineId && ctx.qcStats && ctx.qcStats.remaining > 0) {
          ctx.updateQcDraft({ eventType: 'accept', quantity: ctx.qcStats.remaining })
          setTimeout(() => ctx.onCreateQcEvent(), 100)
        }
      },
    },
    {
      key: 'h',
      handler: () => {
        if (ctx.selectedQcLineId && ctx.qcStats && ctx.qcStats.remaining > 0) {
          const reason = window.prompt('Enter reason code for hold:')
          if (reason !== null) {
            const notes = window.prompt('Enter notes (optional):')
            ctx.updateQcDraft({ eventType: 'hold', quantity: ctx.qcStats.remaining, reasonCode: reason, notes: notes || '' })
            setTimeout(() => ctx.onCreateQcEvent(), 100)
          }
        }
      },
    },
    {
      key: 'r',
      handler: () => {
        if (ctx.selectedQcLineId && ctx.qcStats && ctx.qcStats.remaining > 0) {
          const reason = window.prompt('Enter reason code for rejection:')
          if (reason !== null) {
            const notes = window.prompt('Enter notes (optional):')
            ctx.updateQcDraft({ eventType: 'reject', quantity: ctx.qcStats.remaining, reasonCode: reason, notes: notes || '' })
            setTimeout(() => ctx.onCreateQcEvent(), 100)
          }
        }
      },
    },
    {
      key: 'n',
      handler: () => {
        // Navigate to next receipt in queue
        const receipts = ctx.filteredReceipts
        if (receipts && ctx.receiptIdForQc) {
          const currentIndex = receipts.findIndex((r) => r.id === ctx.receiptIdForQc)
          if (currentIndex !== -1 && currentIndex < receipts.length - 1) {
            ctx.loadReceiptForQc(receipts[currentIndex + 1].id)
            if (isMobile) setShowSidebar(false)
          }
        }
      },
    },
    {
      key: 'p',
      handler: () => {
        // Navigate to previous receipt in queue
        const receipts = ctx.filteredReceipts
        if (receipts && ctx.receiptIdForQc) {
          const currentIndex = receipts.findIndex((r) => r.id === ctx.receiptIdForQc)
          if (currentIndex > 0) {
            ctx.loadReceiptForQc(receipts[currentIndex - 1].id)
            if (isMobile) setShowSidebar(false)
          }
        }
      },
    },
    {
      key: '/',
      handler: () => {
        searchRef.current?.focus()
      },
      preventDefault: true,
    },
    {
      key: '?',
      handler: () => setShowShortcutsHelp(true),
      shift: true,
    },
  ])

  const bulkActions = ctx.selectedQcLineIds.size > 0 
    ? [
        ...createQcBulkActions({
          onBulkAccept: () => handleBulkAction('bulk-accept'),
          onBulkHold: () => handleBulkAction('bulk-hold'),
          onBulkReject: () => handleBulkAction('bulk-reject'),
          isProcessing: false,
        }),
        {
          id: 'bulk-select-all',
          label: 'Select All',
          icon: BulkActionIcons.accept,
          variant: 'secondary' as const,
        },
      ]
    : []

  return (
    <ReceivingLayout>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">QC Classification</h2>
        </div>
        
        {/* Mobile Sidebar Toggle */}
        {isMobile && (
          <button
            onClick={() => setShowSidebar(!showSidebar)}
            className="lg:hidden p-2 rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors"
            aria-label="Toggle sidebar"
          >
            <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}
      </div>

      <div className={`grid gap-6 ${isMobile ? 'grid-cols-1' : 'lg:grid-cols-[minmax(0,1fr)_340px]'}`}>
        {/* Main Content */}
        <div className={`space-y-6 ${isMobile && showSidebar ? 'hidden' : 'block'}`}>
          {/* Bulk Operations Bar */}
          {ctx.selectedQcLineIds.size > 0 && (
            <BulkOperationsBar
              selectedCount={ctx.selectedQcLineIds.size}
              totalCount={ctx.filteredReceiptLines.length}
              actions={bulkActions}
              onAction={handleBulkAction}
              onClearSelection={ctx.clearQcLineSelection}
              isProcessing={ctx.isBulkProcessing}
            />
          )}

          {/* Search and Filters */}
          <SearchFiltersBar
            filters={ctx.receivingFilters}
            onFiltersChange={ctx.setReceivingFilters}
            showQcFilters={true}
          />

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

          <Section
            title="Quality control"
            description="Classify received goods as accepted, on hold, or rejected."
          >
            <Card>
              {!ctx.receiptIdForQc ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="text-slate-400 mb-4">
                    <svg className="w-16 h-16 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-slate-900 mb-2">No receipt loaded</h3>
                  <p className="text-sm text-slate-600 max-w-sm">
                    Select a receipt from the sidebar to classify QC, or post a new receipt.
                  </p>
                </div>
              ) : ctx.receiptQuery.isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <LoadingSpinner />
                </div>
              ) : !ctx.receiptQuery.data ? (
                <Alert variant="error" title="Receipt not found" message="It may have been deleted." />
              ) : (
                <div className="space-y-6">
                  {/* Receipt Document */}
                  <ReceiptDocument receipt={ctx.receiptQuery.data} showQcStatus={true} />

                  {/* QC Lines Selection */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-sm font-medium text-slate-700">
                        Select line for QC
                        {ctx.filteredReceiptLines.length !== (ctx.receiptQuery.data.lines ?? []).length && (
                          <span className="ml-2 text-xs text-slate-500">
                            ({ctx.filteredReceiptLines.length} of {ctx.receiptQuery.data.lines?.length ?? 0} shown)
                          </span>
                        )}
                      </h4>
                      {ctx.filteredReceiptLines.length > 0 && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={ctx.selectAllQcLines}
                        >
                          Select All ({ctx.filteredReceiptLines.length})
                        </Button>
                      )}
                    </div>
                    <div className="space-y-2">
                      {ctx.filteredReceiptLines.map((line) => (
                        <div
                          key={line.id}
                          className={`
                            flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer
                            ${line.id === ctx.activeQcLineId ? 'bg-indigo-50 border-indigo-300' : 'bg-white border-slate-200 hover:border-slate-300'}
                            ${ctx.selectedQcLineIds.has(line.id) ? 'ring-2 ring-indigo-500' : ''}
                          `}
                        >
                          <input
                            type="checkbox"
                            checked={ctx.selectedQcLineIds.has(line.id)}
                            onChange={() => ctx.toggleQcLineSelection(line.id)}
                            className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                            onClick={(e) => e.stopPropagation()}
                          />
                          <div
                            className="flex-1 grid grid-cols-4 gap-4"
                            onClick={() => ctx.setSelectedQcLineId(line.id)}
                          >
                            <div>
                              <div className="text-xs text-slate-500">Item</div>
                              <div className="text-sm font-medium text-slate-900">
                                {line.itemSku ?? line.itemId ?? 'Item'}
                              </div>
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
                              <div className="text-xs text-slate-500">Remaining</div>
                              <div className="text-sm font-medium text-slate-900">
                                {line.qcSummary?.remainingUninspectedQuantity ?? 0}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* QC Detail Panel */}
                  {ctx.selectedQcLine && ctx.qcStats && (
                    <div className="border-t border-slate-200 pt-6">
                      <QcDetailPanel
                        line={ctx.selectedQcLine}
                        qcStats={ctx.qcStats}
                        qcRemaining={ctx.qcStats.remaining}
                        qcEventType={ctx.qcEventType}
                        qcQuantity={ctx.qcQuantity}
                        qcReasonCode={ctx.qcReasonCode}
                        qcNotes={ctx.qcNotes}
                        qcQuantityInvalid={ctx.qcQuantityInvalid}
                        canRecordQc={ctx.canRecordQc}
                        qcEvents={ctx.qcEventsList}
                        qcEventsLoading={false}
                        qcEventsError={false}
                        lastEvent={ctx.lastQcEvent}
                        mutationErrorMessage={undefined}
                        mutationPending={ctx.qcEventMutation.isPending}
                        onEventTypeChange={(eventType) => ctx.updateQcDraft({ eventType })}
                        onQuantityChange={(quantity) => ctx.updateQcDraft({ quantity })}
                        onReasonCodeChange={(reasonCode) => ctx.updateQcDraft({ reasonCode })}
                        onNotesChange={(notes) => ctx.updateQcDraft({ notes })}
                        onRecord={ctx.onCreateQcEvent}
                        putawayAvailable={0}
                        putawayBlockedReason={null}
                      />
                    </div>
                  )}

                  {/* QC Complete Notice */}
                  {!ctx.qcNeedsAttention && (
                    <Alert
                      variant="success"
                      title="QC classification complete"
                      message="All lines have been classified. You can now proceed to putaway."
                      action={
                        <Button
                          size="sm"
                          onClick={() => {
                            if (ctx.receiptIdForQc) {
                              ctx.updateReceivingParams({ receiptId: ctx.receiptIdForQc })
                              navigate(`/receiving/putaway?receiptId=${ctx.receiptIdForQc}`)
                            }
                          }}
                        >
                          Plan putaway →
                        </Button>
                      }
                    />
                  )}
                </div>
              )}
            </Card>
          </Section>
        </div>

        {/* Sidebar */}
        <aside className={`space-y-6 ${isMobile && !showSidebar ? 'hidden' : 'block'}`}>
          {/* Mobile: Back to Content Button */}
          {isMobile && showSidebar && (
            <button
              onClick={() => setShowSidebar(false)}
              className="w-full flex items-center justify-center gap-2 py-2 px-4 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back to Content
            </button>
          )}

          {/* QC Batch Queue */}
          <QcBatchQueue
            receipts={ctx.filteredReceipts.length > 0 ? ctx.filteredReceipts : (ctx.recentReceiptsQuery.data?.data || [])}
            activeReceiptId={ctx.receiptIdForQc}
            onSelectReceipt={(id) => {
              ctx.loadReceiptForQc(id)
              if (isMobile) setShowSidebar(false)
            }}
            isLoading={ctx.recentReceiptsQuery.isLoading}
          />

          {/* Current Receipt QC Summary */}
          {ctx.receiptQuery.data && (
            <QcMetricsChart
              metrics={{
                totalQuantity: ctx.receiptQuery.data.lines?.reduce(
                  (sum, line) => sum + line.quantityReceived,
                  0
                ) || 0,
                accepted: ctx.receiptTotals.accepted,
                hold: ctx.receiptTotals.hold,
                rejected: ctx.receiptTotals.reject,
                remaining: ctx.receiptTotals.remaining,
              }}
            />
          )}
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
