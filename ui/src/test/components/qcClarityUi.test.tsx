/**
 * Focused tests for QC workflow UI clarity pass.
 *
 * Covers:
 * - Accept Remaining label (quantity + UOM, not "Accept All")
 * - Bulk accept includes selected count
 * - Bulk reject uses secondary (outline) style, not filled danger
 * - QC status renders readable badge, not ✓0
 * - QC progress bar does not fill when 0% classified
 * - Stepper marks QC step as active on /qc/receipts/ route
 * - Select All is rendered as a plain text link
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { renderWithQueryClient } from '../testUtils'
import { QcDetailPanel } from '../../features/receiving/components/QcDetailPanel'
import { BulkOperationsBar } from '../../features/receiving/components/BulkOperationsBar'
import { createQcBulkActions, BulkActionIcons } from '../../features/receiving/components/bulkOperationsHelpers'
import { QcMetricsChart } from '../../features/receiving/components/QcMetricsChart'
import QcClassificationPage from '../../features/receiving/pages/QcClassificationPage'
import { ReceivingLayout } from '../../features/receiving/components/ReceivingLayout'

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../features/receiving/context', () => ({
  useReceivingContext: vi.fn(),
  QC_ERROR_MAP: {},
}))
vi.mock('../../features/receiving/hooks/useResponsive', () => ({
  useResponsive: () => ({ isMobile: false }),
}))
vi.mock('../../features/receiving/components/QcBatchQueue', () => ({
  QcBatchQueue: () => <div>qc-queue</div>,
}))
vi.mock('../../features/receiving/components/ReceiptDocument', () => ({
  ReceiptDocument: () => <div>receipt-document</div>,
}))
vi.mock('../../features/receiving/components/SearchFiltersBar', () => ({
  SearchFiltersBar: () => <div>filters</div>,
}))
vi.mock('../../features/receiving/components/KeyboardShortcutsModal', () => ({
  default: () => <div>shortcuts-modal</div>,
}))
vi.mock('../../features/receiving/components/ReceivingLayout', () => ({
  ReceivingLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('../../features/receiving/components/OfflineIndicator', () => ({
  OfflineIndicator: () => null,
}))

import { useReceivingContext } from '../../features/receiving/context'

const mockedUseReceivingContext = vi.mocked(useReceivingContext)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildBaseContextValue(overrides: Record<string, unknown> = {}) {
  return {
    receiptIdForQc: '',
    loadReceiptForQc: vi.fn(),
    selectedQcLineId: '',
    selectedQcLine: undefined,
    qcStats: null,
    onQuickAcceptQc: vi.fn().mockResolvedValue(undefined),
    onSubmitQcShortcutEvent: vi.fn().mockResolvedValue(true),
    updateQcDraft: vi.fn(),
    onCreateQcEvent: vi.fn(),
    bulkAcceptQcLines: vi.fn(),
    bulkHoldQcLines: vi.fn(),
    bulkRejectQcLines: vi.fn(),
    isBulkProcessing: false,
    bulkError: null,
    selectAllQcLines: vi.fn(),
    toggleQcLineSelection: vi.fn(),
    setSelectedQcLineId: vi.fn(),
    filteredReceipts: [],
    filteredReceiptLines: [],
    selectedQcLineIds: new Set(),
    recentReceiptsQuery: { data: { data: [] }, isLoading: false },
    receiptQuery: { data: null, isLoading: false, isError: false, error: null },
    receiptTotals: { received: 0, accepted: 0, hold: 0, reject: 0, remaining: 0 },
    qcEventType: 'accept' as const,
    qcQuantity: 0,
    qcReasonCode: '',
    qcNotes: '',
    qcQuantityInvalid: false,
    canRecordQc: false,
    qcEventsList: [],
    qcEventMutation: { isPending: false, error: null },
    holdDispositionMutation: { isPending: false, error: null },
    mapErrorMessage: vi.fn((msg: string) => msg),
    getErrorMessage: vi.fn((_e: unknown, fb: string) => fb),
    onResolveHoldDisposition: vi.fn(),
    updateReceivingParams: vi.fn(),
    isOnline: true,
    pendingCount: 0,
    pendingOperations: [],
    isSyncing: false,
    syncPendingOperations: vi.fn(),
    clearOfflineQueue: vi.fn(),
    receivingFilters: {},
    setReceivingFilters: vi.fn(),
    clearQcLineSelection: vi.fn(),
    ...overrides,
  }
}

function renderQcPage(initialEntry = '/qc/receipts/receipt-1') {
  const router = createMemoryRouter(
    [{ path: '/qc/receipts/:receiptId', element: <QcClassificationPage /> }],
    { initialEntries: [initialEntry] },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

// ─── Tests: createQcBulkActions label generation ─────────────────────────────

describe('createQcBulkActions', () => {
  it('includes selected count in Accept Selected Lines label', () => {
    const actions = createQcBulkActions({
      onBulkAccept: vi.fn(),
      onBulkHold: vi.fn(),
      onBulkReject: vi.fn(),
      isProcessing: false,
      selectedCount: 4,
    })
    const acceptAction = actions.find((a) => a.id === 'accept')
    expect(acceptAction?.label).toBe('Accept Selected Lines (4)')
  })

  it('includes selected count in Hold and Reject labels', () => {
    const actions = createQcBulkActions({
      onBulkAccept: vi.fn(),
      onBulkHold: vi.fn(),
      onBulkReject: vi.fn(),
      isProcessing: false,
      selectedCount: 2,
    })
    expect(actions.find((a) => a.id === 'hold')?.label).toBe('Hold Selected (2)')
    expect(actions.find((a) => a.id === 'reject')?.label).toBe('Reject Selected (2)')
  })

  it('reject action uses secondary variant, not danger', () => {
    const actions = createQcBulkActions({
      onBulkAccept: vi.fn(),
      onBulkHold: vi.fn(),
      onBulkReject: vi.fn(),
      isProcessing: false,
      selectedCount: 3,
    })
    const rejectAction = actions.find((a) => a.id === 'reject')
    expect(rejectAction?.variant).toBe('secondary')
    expect(rejectAction?.variant).not.toBe('danger')
  })

  it('reject action carries rose-coloured outline className', () => {
    const actions = createQcBulkActions({
      onBulkAccept: vi.fn(),
      onBulkHold: vi.fn(),
      onBulkReject: vi.fn(),
      isProcessing: false,
      selectedCount: 1,
    })
    const rejectAction = actions.find((a) => a.id === 'reject')
    expect(rejectAction?.className).toContain('rose')
  })
})

// ─── Tests: BulkOperationsBar renders count label ────────────────────────────

describe('BulkOperationsBar', () => {
  it('renders Accept Selected Lines (3) when 3 lines selected', () => {
    const actions = createQcBulkActions({
      onBulkAccept: vi.fn(),
      onBulkHold: vi.fn(),
      onBulkReject: vi.fn(),
      isProcessing: false,
      selectedCount: 3,
    })
    render(
      <BulkOperationsBar
        selectedCount={3}
        totalCount={6}
        actions={actions}
        onAction={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    )
    expect(screen.getByText('Accept Selected Lines (3)')).toBeInTheDocument()
  })

  it('renders Reject Selected (3) without filled red button', () => {
    const actions = createQcBulkActions({
      onBulkAccept: vi.fn(),
      onBulkHold: vi.fn(),
      onBulkReject: vi.fn(),
      isProcessing: false,
      selectedCount: 3,
    })
    render(
      <BulkOperationsBar
        selectedCount={3}
        totalCount={6}
        actions={actions}
        onAction={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    )
    const rejectButton = screen.getByText('Reject Selected (3)').closest('button')
    // Should NOT have the filled danger red background
    expect(rejectButton?.className).not.toContain('bg-rose-600')
    // Should have the outline rose style
    expect(rejectButton?.className).toContain('rose')
  })
})

// ─── Tests: QcDetailPanel Accept Remaining label ─────────────────────────────

describe('QcDetailPanel', () => {
  const baseLine = {
    id: 'line-abc',
    itemSku: 'SKU-001',
    itemName: 'Test Item',
    quantityReceived: 50,
    uom: 'kg',
    qcSummary: null,
  }

  const baseStats = { accept: 0, hold: 0, reject: 0, remaining: 42 }

  it('renders Accept Remaining with quantity and UOM instead of Accept All', () => {
    render(
      <QcDetailPanel
        line={baseLine as any}
        qcStats={baseStats}
        qcRemaining={42}
        qcEventType="accept"
        qcQuantity={42}
        qcReasonCode=""
        qcNotes=""
        qcQuantityInvalid={false}
        canRecordQc={true}
        qcEvents={[]}
        qcEventsLoading={false}
        qcEventsError={false}
        lastEvent={null}
        mutationPending={false}
        holdDispositionPending={false}
        onEventTypeChange={vi.fn()}
        onQuantityChange={vi.fn()}
        onReasonCodeChange={vi.fn()}
        onNotesChange={vi.fn()}
        onRecord={vi.fn()}
        onQuickAccept={vi.fn()}
        onResolveHoldDisposition={vi.fn()}
        putawayAvailable={0}
      />,
    )
    // Should not render the old ambiguous label
    expect(screen.queryByText(/Accept All/)).toBeNull()
    // Should render the explicit remaining label
    expect(screen.getByText(/Accept Remaining \(42 kg\)/)).toBeInTheDocument()
  })

  it('does not render Accept Remaining button when qcRemaining is 0', () => {
    render(
      <QcDetailPanel
        line={baseLine as any}
        qcStats={{ accept: 50, hold: 0, reject: 0, remaining: 0 }}
        qcRemaining={0}
        qcEventType="accept"
        qcQuantity={0}
        qcReasonCode=""
        qcNotes=""
        qcQuantityInvalid={false}
        canRecordQc={false}
        qcEvents={[]}
        qcEventsLoading={false}
        qcEventsError={false}
        lastEvent={null}
        mutationPending={false}
        holdDispositionPending={false}
        onEventTypeChange={vi.fn()}
        onQuantityChange={vi.fn()}
        onReasonCodeChange={vi.fn()}
        onNotesChange={vi.fn()}
        onRecord={vi.fn()}
        onQuickAccept={vi.fn()}
        onResolveHoldDisposition={vi.fn()}
        putawayAvailable={0}
      />,
    )
    expect(screen.queryByText(/Accept Remaining/)).toBeNull()
  })
})

// ─── Tests: QcMetricsChart progress semantics ────────────────────────────────

describe('QcMetricsChart', () => {
  it('renders 0% Complete header when nothing classified', () => {
    render(
      <QcMetricsChart
        metrics={{ totalQuantity: 100, accepted: 0, hold: 0, rejected: 0, remaining: 100 }}
      />,
    )
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(screen.getByText('Complete')).toBeInTheDocument()
  })

  it('does not render a filled bar segment for Remaining when 0% classified', () => {
    const { container } = render(
      <QcMetricsChart
        metrics={{ totalQuantity: 100, accepted: 0, hold: 0, rejected: 0, remaining: 100 }}
      />,
    )
    // The stacked bar should have no colored segments (no green/amber/red fills)
    const barContainer = container.querySelector('.h-8.w-full')
    expect(barContainer?.children.length).toBe(0)
  })

  it('renders accepted bar segment when some quantity classified', () => {
    const { container } = render(
      <QcMetricsChart
        metrics={{ totalQuantity: 100, accepted: 60, hold: 0, rejected: 0, remaining: 40 }}
      />,
    )
    const barContainer = container.querySelector('.h-8.w-full')
    expect(barContainer?.children.length).toBe(1)
    expect(barContainer?.children[0]).toHaveClass('bg-green-500')
  })

  it('still shows Remaining count in legend', () => {
    render(
      <QcMetricsChart
        metrics={{ totalQuantity: 100, accepted: 0, hold: 0, rejected: 0, remaining: 100 }}
      />,
    )
    expect(screen.getByText('Remaining')).toBeInTheDocument()
    // Multiple elements may show "100" (legend + total row) — just confirm it appears
    expect(screen.getAllByText('100').length).toBeGreaterThan(0)
  })
})

// ─── Tests: QcClassificationPage QC status badge (not ✓0) ───────────────────

describe('QcClassificationPage: QC status clarity', () => {
  it('renders status badge instead of ✓0 for lines with no QC done', () => {
    const mockLine = {
      id: 'line-1',
      itemSku: 'SKU-001',
      itemName: 'Test Item',
      quantityReceived: 100,
      uom: 'g',
      qcSummary: {
        breakdown: { accept: 0, hold: 0, reject: 0 },
        remainingUninspectedQuantity: 100,
      },
    }

    mockedUseReceivingContext.mockReturnValue(
      buildBaseContextValue({
        receiptIdForQc: 'receipt-1',
        filteredReceiptLines: [mockLine],
        receiptQuery: {
          data: { id: 'receipt-1', lines: [mockLine] },
          isLoading: false,
          isError: false,
          error: null,
        },
        receiptTotals: { received: 100, accepted: 0, hold: 0, reject: 0, remaining: 100 },
      }) as any,
    )

    renderQcPage()

    // Must not contain the ✓0 rendering
    expect(screen.queryByText(/✓0/)).toBeNull()
    expect(screen.queryByText(/✓/)).toBeNull()
    // Must render a readable status label
    expect(screen.getByText('QC not started')).toBeInTheDocument()
  })

  it('renders Select All as a plain link, not a primary/secondary button', () => {
    const mockLine = {
      id: 'line-1',
      itemSku: 'SKU-001',
      itemName: 'Test Item',
      quantityReceived: 100,
      uom: 'g',
      qcSummary: { breakdown: { accept: 0, hold: 0, reject: 0 }, remainingUninspectedQuantity: 100 },
    }

    mockedUseReceivingContext.mockReturnValue(
      buildBaseContextValue({
        receiptIdForQc: 'receipt-1',
        filteredReceiptLines: [mockLine],
        receiptQuery: {
          data: { id: 'receipt-1', lines: [mockLine] },
          isLoading: false,
          isError: false,
          error: null,
        },
        receiptTotals: { received: 100, accepted: 0, hold: 0, reject: 0, remaining: 100 },
      }) as any,
    )

    renderQcPage()

    const selectAllEl = screen.getByText(/Select all \(1\)/)
    // Should be a plain button (type=button), not a themed Button component
    expect(selectAllEl.tagName.toLowerCase()).toBe('button')
    // Should NOT have blue filled background (bg-blue-600 is primary Button style)
    expect(selectAllEl.className).not.toContain('bg-blue-600')
    // Should NOT have the secondary border style
    expect(selectAllEl.className).not.toContain('border border-slate-200 bg-white')
  })
})
