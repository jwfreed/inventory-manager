import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, Card, Combobox, Input, Section, Textarea } from '@shared/ui'
import { formatDate } from '../../../lib/formatters'
import { ReceiptLinesTable } from '../components/ReceiptLinesTable'
import { WorkflowProgressChart } from '../components/WorkflowProgressChart'
import { KeyboardHint } from '../components/KeyboardHint'
import { ReceivingLayout } from '../components/ReceivingLayout'
import { useReceivingContext } from '../context'
import { useResponsive } from '../hooks/useResponsive'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { useAuth } from '@shared/auth'

const KeyboardShortcutsModal = lazy(() => import('../components/KeyboardShortcutsModal'))

export default function ReceiptCapturePage() {
  const navigate = useNavigate()
  const ctx = useReceivingContext()
  const { user } = useAuth()
  const { isMobile } = useResponsive()
  const [showSidebar, setShowSidebar] = useState(false)
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false)
  const [scanQuery, setScanQuery] = useState('')
  const [focusLineId, setFocusLineId] = useState<string | null>(null)
  const [varianceFilter, setVarianceFilter] = useState<'all' | 'match' | 'short' | 'over' | 'missing'>('all')
  const posted = ctx.receiptMutation.isSuccess
  const [poVersion, setPoVersion] = useState<string | null>(null)

  const formatEntityLabel = (code?: string | null, name?: string | null) => {
    if (code && name) return `${code} — ${name}`
    return name || code || 'Data unavailable'
  }

  useEffect(() => {
    if (!ctx.poQuery.data?.id) return
    if (ctx.receiptLineInputs === null) {
      setPoVersion(ctx.poQuery.data.updatedAt ?? null)
    }
  }, [ctx.poQuery.data?.id, ctx.poQuery.data?.updatedAt, ctx.receiptLineInputs])

  const poUpdatedWhileEditing =
    !!ctx.poQuery.data?.updatedAt &&
    !!poVersion &&
    ctx.poQuery.data.updatedAt !== poVersion &&
    ctx.receiptLineInputs !== null &&
    !posted

  const filteredLines = useMemo(() => {
    let rows = ctx.receiptLineInputs
    if (scanQuery.trim()) {
      const needle = scanQuery.trim().toLowerCase()
      rows = rows.filter((line) => line.itemLabel.toLowerCase().includes(needle))
    }
    if (varianceFilter === 'match') {
      rows = rows.filter((line) => {
        const receivedQty = line.receivedQty === '' ? 0 : Number(line.receivedQty)
        return receivedQty > 0 && receivedQty === line.expectedQty
      })
    } else if (varianceFilter === 'short') {
      rows = rows.filter((line) => {
        const receivedQty = line.receivedQty === '' ? 0 : Number(line.receivedQty)
        return receivedQty > 0 && receivedQty < line.expectedQty
      })
    } else if (varianceFilter === 'over') {
      rows = rows.filter((line) => {
        const receivedQty = line.receivedQty === '' ? 0 : Number(line.receivedQty)
        return receivedQty > line.expectedQty
      })
    } else if (varianceFilter === 'missing') {
      rows = rows.filter((line) => {
        const receivedQty = line.receivedQty === '' ? 0 : Number(line.receivedQty)
        return line.expectedQty > 0 && receivedQty === 0
      })
    }
    return rows
  }, [ctx.receiptLineInputs, scanQuery, varianceFilter])

  const qcRequiredCount = ctx.receiptLineSummary.lines.filter((line) => line.requiresQc).length
  const poReceipts = useMemo(() => {
    if (!ctx.selectedPoId) return []
    const receipts = ctx.recentReceiptsQuery.data?.data ?? []
    return receipts.filter((receipt) => receipt.purchaseOrderId === ctx.selectedPoId)
  }, [ctx.selectedPoId, ctx.recentReceiptsQuery.data])

  const readyLinesCount = ctx.receiptLineSummary.lines.filter(
    (line) => line.receivedQty > 0 && line.delta === 0,
  ).length
  const discrepancyCount = ctx.receiptLineSummary.discrepancyLines.length
  const missingDataCount = ctx.receiptLineSummary.lines.filter(
    (line) => line.expectedQty > 0 && line.receivedQty === 0,
  ).length
  const missingRequiredCount =
    ctx.receiptLineSummary.missingReasons.length +
    ctx.receiptLineSummary.missingLotSerial.length +
    ctx.receiptLineSummary.overApprovalMissing.length +
    ctx.receiptLineSummary.invalidLines.length

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
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  if (ctx.receiptLineSummary.discrepancyLines.length > 0) {
                    const ok = window.confirm(
                      'Discrepancies detected. Confirm you want to post this receipt.',
                    )
                    if (!ok) {
                      e.preventDefault()
                      return
                    }
                  }
                  ctx.onCreateReceipt(e)
                }}
                data-receipt-form
              >
                {/* PO Selection */}
                <div className="rounded-lg border border-slate-200 p-4 space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Purchase order
                    </label>
                    <select
                      value={ctx.selectedPoId}
                      onChange={(e) => ctx.handlePoChange(e.target.value)}
                      disabled={ctx.receiptMutation.isPending || posted}
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
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        <div className="font-semibold text-slate-900">
                          PO {ctx.poQuery.data.poNumber || 'Unassigned'}
                        </div>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                          {ctx.poQuery.data.status}
                        </span>
                        {ctx.receiptMutation.isSuccess && (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                            Posted
                          </span>
                        )}
                        {ctx.poQuery.data.status?.toLowerCase() === 'approved' && (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                            Eligible to receive
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                        <div>
                          <span className="text-slate-500">Vendor:</span>{' '}
                          <span className="font-medium text-slate-900">
                            {formatEntityLabel(ctx.poQuery.data.vendorCode, ctx.poQuery.data.vendorName)}
                          </span>
                          {!ctx.poQuery.data.vendorName && !ctx.poQuery.data.vendorCode && (
                            <button
                              type="button"
                              onClick={() => void ctx.poQuery.refetch()}
                              className="ml-2 text-xs text-brand-600 hover:text-brand-800"
                            >
                              Retry
                            </button>
                          )}
                        </div>
                        <div>
                          <span className="text-slate-500">Expected:</span>{' '}
                          <span className="font-medium text-slate-900">
                            {ctx.poQuery.data.expectedDate ? formatDate(ctx.poQuery.data.expectedDate) : 'N/A'}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500">Ship to:</span>{' '}
                          <span className="font-medium text-slate-900">
                            {formatEntityLabel(
                              ctx.poQuery.data.shipToLocationCode,
                              ctx.poQuery.data.shipToLocationName
                            )}
                          </span>
                          {!ctx.poQuery.data.shipToLocationCode &&
                            !ctx.locationOptions.find((loc) => loc.value === ctx.poQuery.data.shipToLocationId) && (
                              <span className="ml-2 text-xs text-slate-500">Data unavailable.</span>
                            )}
                        </div>
                        <div>
                          <span className="text-slate-500">Receiving:</span>{' '}
                          <span className="font-medium text-slate-900">
                            {formatEntityLabel(
                              ctx.poQuery.data.receivingLocationCode,
                              ctx.poQuery.data.receivingLocationName
                            )}
                          </span>
                          <div className="text-xs text-slate-500">Staging after receipt.</div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {ctx.selectedPoId && ctx.poQuery.data && (
                  <>
                    {poUpdatedWhileEditing && (
                      <Alert
                        variant="warning"
                        title="PO updated"
                        message="This purchase order was updated while you were receiving. Reload lines to avoid mismatches."
                        action={
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              void ctx.poQuery.refetch().then((res) => {
                                setPoVersion(res.data?.updatedAt ?? ctx.poQuery.data?.updatedAt ?? null)
                              })
                              ctx.resetReceiptLines()
                            }}
                          >
                            Reload lines
                          </Button>
                        }
                      />
                    )}
                    {/* Receiving Location */}
                    <div>
                      <Combobox
                        label="Receiving location"
                        placeholder="Select location…"
                        options={ctx.locationOptions}
                        value={ctx.resolvedReceivedToLocationId}
                        onChange={(val) => ctx.setReceivedToLocationId(val)}
                        disabled={ctx.receiptMutation.isPending || posted}
                      />
                      <p className="mt-1 text-xs text-slate-500">
                        Receiving location (staging after receipt).
                      </p>
                    </div>

                    {/* Receipt Lines */}
                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <label className="block text-sm font-medium text-slate-700">
                          Receipt lines{' '}
                          <span className="text-slate-500">
                            ({ctx.receiptLineSummary.lines.length} lines)
                          </span>
                        </label>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={ctx.receiptMutation.isPending || posted}
                          onClick={() => {
                            ctx.setReceiptLineInputs((prev) => {
                              const source = prev ?? ctx.receiptLineInputs
                              return source.map((line) => ({
                                ...line,
                                receivedQty: line.expectedQty ?? 0,
                                discrepancyReason: '',
                              }))
                            })
                          }}
                        >
                          Receive all expected
                        </Button>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <label className="text-xs uppercase tracking-wide text-slate-500">
                          Scan or search
                          <Input
                            value={scanQuery}
                            onChange={(e) => setScanQuery(e.target.value)}
                            placeholder="Scan SKU or type to filter"
                            className="mt-1 w-64"
                            disabled={ctx.receiptMutation.isPending || posted}
                            onKeyDown={(e) => {
                              if (e.key !== 'Enter') return
                              const needle = scanQuery.trim().toLowerCase()
                              if (!needle) return
                              const match = ctx.receiptLineInputs.find((line) =>
                                line.itemLabel.toLowerCase().includes(needle),
                              )
                              if (match) {
                                setFocusLineId(match.purchaseOrderLineId)
                                setScanQuery('')
                              }
                            }}
                          />
                        </label>
                        <label className="text-xs uppercase tracking-wide text-slate-500">
                          Filter
                          <select
                            className="mt-1 w-40 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900"
                            value={varianceFilter}
                            onChange={(e) => setVarianceFilter(e.target.value as typeof varianceFilter)}
                            disabled={ctx.receiptMutation.isPending || posted}
                          >
                            <option value="all">All</option>
                            <option value="match">Match</option>
                            <option value="short">Short</option>
                            <option value="over">Over</option>
                            <option value="missing">Not received</option>
                          </select>
                        </label>
                        <div className="text-xs text-slate-600">
                          {readyLinesCount} ready - {discrepancyCount} discrepancies - {missingRequiredCount} missing data - {missingDataCount} not received
                        </div>
                      </div>
                      {qcRequiredCount > 0 && (
                        <Alert
                          variant="info"
                          title="QC required"
                          message={`${qcRequiredCount} line(s) require QC. QC will be the next step after posting.`}
                        />
                      )}
                      {!posted && (ctx.receiptLineSummary.missingReasons.length > 0 ||
                        ctx.receiptLineSummary.invalidLines.length > 0 ||
                        ctx.receiptLineSummary.missingLotSerial.length > 0 ||
                        ctx.receiptLineSummary.overApprovalMissing.length > 0 ||
                        !ctx.resolvedReceivedToLocationId ||
                        ctx.poQuery.data?.status?.toLowerCase() !== 'approved') && (
                        <div aria-live="polite">
                          <Alert
                            variant="warning"
                            title="Review required"
                            message={
                              [
                                ctx.poQuery.data?.status?.toLowerCase() !== 'approved'
                                  ? 'PO must be approved to receive.'
                                  : null,
                                !ctx.resolvedReceivedToLocationId
                                  ? 'Receiving location is required.'
                                  : null,
                                ctx.receiptLineSummary.invalidLines.length > 0
                                  ? 'Negative quantities are not allowed.'
                                  : null,
                                ctx.receiptLineSummary.missingReasons.length > 0
                                  ? 'Discrepancy reasons are required.'
                                  : null,
                                ctx.receiptLineSummary.missingLotSerial.length > 0
                                  ? 'Lot/serial data is required for some lines.'
                                  : null,
                                ctx.receiptLineSummary.overApprovalMissing.length > 0
                                  ? 'Over-receipt approvals are required.'
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(' ')
                            }
                            action={
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  const first =
                                    ctx.receiptLineSummary.invalidLines[0] ||
                                    ctx.receiptLineSummary.missingReasons[0] ||
                                    ctx.receiptLineSummary.missingLotSerial[0] ||
                                    ctx.receiptLineSummary.overApprovalMissing[0]
                                  if (first) {
                                    setVarianceFilter('all')
                                    setScanQuery('')
                                    setFocusLineId(first.purchaseOrderLineId)
                                  }
                                }}
                              >
                                Review errors
                              </Button>
                            }
                          />
                        </div>
                      )}
                      <ReceiptLinesTable
                        lines={filteredLines}
                        emptyMessage={scanQuery ? 'No lines match this search.' : undefined}
                        onLineChange={(lineId, patch) => {
                          ctx.setReceiptLineInputs((prev) => {
                            if (!prev) return prev
                            return prev.map((line) =>
                              line.purchaseOrderLineId === lineId ? { ...line, ...patch } : line
                            )
                          })
                        }}
                        focusLineId={focusLineId}
                        onFocusLineHandled={() => setFocusLineId(null)}
                        disabled={ctx.receiptMutation.isPending || posted}
                      />
                    </div>

                    {/* Discrepancy Alert */}
                    {!posted && ctx.receiptLineSummary.discrepancyLines.length > 0 && (
                      <Alert
                        variant="warning"
                        title="Discrepancies detected"
                        message={`${ctx.receiptLineSummary.discrepancyLines.length} line(s) have quantity variances.${ctx.receiptLineSummary.missingReasons.length > 0 ? ` Reason required for ${ctx.receiptLineSummary.missingReasons.length} line(s).` : ''}`}
                        action={
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              const first = ctx.receiptLineSummary.missingReasons[0]
                              if (first) {
                                setVarianceFilter('all')
                                setScanQuery('')
                                setFocusLineId(first.purchaseOrderLineId)
                              }
                            }}
                          >
                            Review
                          </Button>
                        }
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
                        disabled={ctx.receiptMutation.isPending || posted}
                      />
                    </div>

                    {/* Summary and Submit */}
                    <div className="sticky bottom-0 z-10 -mx-4 border-t border-slate-200 bg-white px-4 py-3 shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
                        <div>
                          <span className="font-medium">{ctx.receiptLineSummary.totalReceived}</span> of{' '}
                          <span className="font-medium">{ctx.receiptLineSummary.totalExpected}</span> expected
                          {ctx.receiptLineSummary.discrepancyLines.length > 0 && (
                            <span className="text-amber-600">
                              {' '}
                              - {ctx.receiptLineSummary.discrepancyLines.length} discrepancies
                            </span>
                          )}
                          {ctx.receiptLineSummary.totalReceived > ctx.receiptLineSummary.totalExpected && (
                            <span className="text-amber-700"> - Over</span>
                          )}
                          {ctx.receiptLineSummary.totalReceived < ctx.receiptLineSummary.totalExpected && (
                            <span className="text-slate-500"> - Partial</span>
                          )}
                          {ctx.receiptLineSummary.totalReceived === ctx.receiptLineSummary.totalExpected && (
                            <span className="text-emerald-700"> - Complete</span>
                          )}
                        </div>
                        <div className="text-xs text-slate-500">
                          Posting as {user?.fullName || user?.email || 'user'} at{' '}
                          {new Date().toLocaleTimeString()}
                        </div>
                        <Button
                          type="submit"
                          disabled={!ctx.canPostReceipt || ctx.receiptMutation.isPending || posted}
                        >
                          {ctx.receiptMutation.isPending ? 'Posting…' : 'Post receipt'}{' '}
                          <KeyboardHint shortcut="Ctrl+S" />
                        </Button>
                      </div>
                    </div>

                    {/* Error Message */}
                    {ctx.receiptMutation.isError && (() => {
                      const message = ctx.getErrorMessage(ctx.receiptMutation.error, 'Failed to create receipt')
                      const isDuplicate = message.toLowerCase().includes('already')
                      return (
                        <Alert
                          variant="error"
                          title="Receipt creation failed"
                          message={message}
                          action={
                            isDuplicate ? (
                              <Button size="sm" variant="secondary" onClick={() => navigate('/receipts')}>
                                View receipts
                              </Button>
                            ) : undefined
                          }
                        />
                      )
                    })()}

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
                                if (qcRequiredCount > 0) {
                                  navigate(`/qc/receipts/${ctx.receiptMutation.data.id}`)
                                } else {
                                  navigate(`/receiving/putaway?receiptId=${ctx.receiptMutation.data.id}`)
                                }
                              }
                            }}
                          >
                            {qcRequiredCount > 0 ? 'Start QC' : 'Start Putaway'}
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

          {ctx.selectedPoId && (
            <Card>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-900">Receipt history</div>
                  <Button size="sm" variant="secondary" onClick={() => navigate('/receipts')}>
                    View all
                  </Button>
                </div>
                {poReceipts.length === 0 ? (
                  <div className="text-xs text-slate-500">No receipts posted for this PO yet.</div>
                ) : (
                  <div className="space-y-2">
                    {poReceipts.slice(0, 4).map((receipt) => (
                      <div key={receipt.id} className="flex items-center justify-between text-sm">
                        <div>
                          <div className="font-medium text-slate-900">
                            Receipt posted {formatDate(receipt.receivedAt)}
                          </div>
                          <div className="text-xs text-slate-500">{receipt.status}</div>
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => navigate(`/receipts/${receipt.id}`)}
                        >
                          View
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
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
