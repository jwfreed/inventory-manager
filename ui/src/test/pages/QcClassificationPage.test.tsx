import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { renderWithQueryClient } from '../testUtils'
import QcClassificationPage from '../../features/receiving/pages/QcClassificationPage'

vi.mock('../../features/receiving/context', () => ({
  useReceivingContext: vi.fn(),
  QC_ERROR_MAP: {},
}))
vi.mock('../../features/receiving/hooks/useResponsive', () => ({
  useResponsive: () => ({ isMobile: false }),
}))
vi.mock('../../features/receiving/components/QcDetailPanel', () => ({
  QcDetailPanel: () => <div>qc-detail</div>,
}))
vi.mock('../../features/receiving/components/QcBatchQueue', () => ({
  QcBatchQueue: () => <div>qc-queue</div>,
}))
vi.mock('../../features/receiving/components/QcMetricsChart', () => ({
  QcMetricsChart: () => <div>qc-metrics</div>,
}))
vi.mock('../../features/receiving/components/ReceiptDocument', () => ({
  ReceiptDocument: () => <div>receipt-document</div>,
}))
vi.mock('../../features/receiving/components/SearchFiltersBar', () => ({
  SearchFiltersBar: () => <div>filters</div>,
}))
vi.mock('../../features/receiving/components/BulkOperationsBar', () => ({
  BulkOperationsBar: () => <div>bulk-ops</div>,
}))
vi.mock('../../features/receiving/components/bulkOperationsHelpers', () => ({
  createQcBulkActions: () => [],
  BulkActionIcons: {},
}))
vi.mock('../../features/receiving/components/KeyboardShortcutsModal', () => ({
  default: () => <div>shortcuts-modal</div>,
}))
vi.mock('../../features/receiving/components/ReceivingLayout', () => ({
  ReceivingLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

import { useReceivingContext } from '../../features/receiving/context'

const mockedUseReceivingContext = vi.mocked(useReceivingContext)

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

function renderPage(initialEntry = '/receiving/qc/receipt-1') {
  const router = createMemoryRouter(
    [
      {
        path: '/receiving/qc/:receiptId',
        element: (
          <>
            <QcClassificationPage />
            <LocationProbe />
          </>
        ),
      },
      {
        path: '/receiving/qc',
        element: (
          <>
            <QcClassificationPage />
            <LocationProbe />
          </>
        ),
      },
      {
        path: '/qc/receipts/:receiptId',
        element: (
          <>
            <QcClassificationPage />
            <LocationProbe />
          </>
        ),
      },
      {
        path: '/receiving',
        element: <LocationProbe />,
      },
      {
        path: '/receiving/putaway',
        element: <LocationProbe />,
      },
    ],
    { initialEntries: [initialEntry] },
  )

  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('QcClassificationPage keyboard shortcuts', () => {
  const buildContextValue = (overrides: Record<string, unknown> = {}) => ({
    receiptIdForQc: 'receipt-1',
    loadReceiptForQc: vi.fn(),
    refreshReceiptDetail: vi.fn().mockResolvedValue(null),
    selectedQcLineId: 'line-1',
    selectedQcLine: { id: 'line-1', uom: 'each' },
    qcStats: { accept: 0, hold: 0, reject: 0, remaining: 5 },
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
    receiptTotals: { received: 0, accepted: 0, hold: 0, reject: 0, remaining: 5 },
    qcEventType: 'accept',
    qcQuantity: 5,
    qcReasonCode: '',
    qcNotes: '',
    qcQuantityInvalid: false,
    canRecordQc: true,
    qcEventsList: [],
    qcEventMutation: { isPending: false },
    holdDispositionMutation: { isPending: false, error: null },
    mapErrorMessage: vi.fn((message: string) => message),
    getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
    onResolveHoldDisposition: vi.fn(),
    updateReceivingParams: vi.fn(),
    isOnline: true,
    pendingCount: 0,
    pendingOperations: [],
    isSyncing: false,
    syncPendingOperations: vi.fn(),
    clearOfflineQueue: vi.fn(),
    ...overrides,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseReceivingContext.mockReturnValue(buildContextValue() as any)
  })

  it('routes the A shortcut through onQuickAcceptQc without setTimeout', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    renderPage()
    fireEvent.keyDown(window, { key: 'a' })

    expect(mockedUseReceivingContext.mock.results[0]?.value.onQuickAcceptQc).toHaveBeenCalledTimes(1)
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it('submits hold and reject shortcuts without setTimeout', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const promptSpy = vi
      .spyOn(window, 'prompt')
      .mockReturnValueOnce('qc-hold')
      .mockReturnValueOnce('hold notes')
      .mockReturnValueOnce('qc-reject')
      .mockReturnValueOnce('reject notes')

    renderPage()
    fireEvent.keyDown(window, { key: 'h' })
    fireEvent.keyDown(window, { key: 'r' })

    const ctx = mockedUseReceivingContext.mock.results[0]?.value
    expect(ctx.onSubmitQcShortcutEvent).toHaveBeenCalledTimes(2)
    expect(ctx.onSubmitQcShortcutEvent).toHaveBeenNthCalledWith(1, {
      purchaseOrderReceiptLineId: 'line-1',
      eventType: 'hold',
      quantity: 5,
      uom: 'each',
      reasonCode: 'qc-hold',
      notes: 'hold notes',
      actorType: 'user',
    })
    expect(ctx.onSubmitQcShortcutEvent).toHaveBeenNthCalledWith(2, {
      purchaseOrderReceiptLineId: 'line-1',
      eventType: 'reject',
      quantity: 5,
      uom: 'each',
      reasonCode: 'qc-reject',
      notes: 'reject notes',
      actorType: 'user',
    })
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(promptSpy).toHaveBeenCalledTimes(4)
  })

  it('does not submit hold or reject shortcuts when the selected line is missing', () => {
    const promptSpy = vi.spyOn(window, 'prompt')
    mockedUseReceivingContext.mockReturnValue(
      buildContextValue({
        selectedQcLine: undefined,
      }) as any,
    )

    renderPage()
    fireEvent.keyDown(window, { key: 'h' })
    fireEvent.keyDown(window, { key: 'r' })

    const ctx = mockedUseReceivingContext.mock.results.at(-1)?.value
    expect(ctx.onSubmitQcShortcutEvent).not.toHaveBeenCalled()
    expect(promptSpy).not.toHaveBeenCalled()
  })

  it('refreshes receipt detail before guiding completed QC to putaway', async () => {
    const refreshReceiptDetail = vi.fn().mockResolvedValue({
      id: 'receipt-1',
      status: 'posted',
      receivedAt: '2026-05-11T00:00:00Z',
      lines: [],
    })
    mockedUseReceivingContext.mockReturnValue(
      buildContextValue({
        refreshReceiptDetail,
        receiptQuery: {
          data: {
            id: 'receipt-1',
            status: 'posted',
            receivedAt: '2026-05-11T00:00:00Z',
            lines: [],
          },
          isLoading: false,
          isError: false,
          error: null,
        },
        receiptTotals: { received: 5, accepted: 5, hold: 0, reject: 0, remaining: 0 },
      }) as any,
    )

    renderPage()

    expect(screen.getByText('QC classification complete')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue to putaway' }))

    await waitFor(() => expect(refreshReceiptDetail).toHaveBeenCalledWith('receipt-1'))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/receiving/putaway'))
  })

  it('turns the no-receipt state into a next QC action when queue work exists', () => {
    const loadReceiptForQc = vi.fn()
    mockedUseReceivingContext.mockReturnValue(
      buildContextValue({
        receiptIdForQc: '',
        selectedQcLineId: '',
        selectedQcLine: undefined,
        loadReceiptForQc,
        recentReceiptsQuery: {
          data: {
            data: [
              {
                id: 'receipt-next',
                receiptNumber: 'R-1001',
                status: 'posted',
                receivedAt: '2026-05-11T00:00:00Z',
                lines: [
                  {
                    id: 'line-1',
                    quantityReceived: 30000,
                    uom: 'g',
                    qcSummary: {
                      remainingUninspectedQuantity: 30000,
                    },
                  },
                ],
              },
            ],
          },
          isLoading: false,
        },
      }) as any,
    )

    renderPage('/receiving/qc')

    expect(screen.getByText('No receipt selected')).toBeInTheDocument()
    expect(screen.getByText('1 receipt is waiting for QC classification.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Load next receipt' }))

    expect(loadReceiptForQc).toHaveBeenCalledWith('receipt-next')
    expect(screen.getByTestId('location')).toHaveTextContent('/qc/receipts/receipt-next')
  })

  it('shows a true no-work QC empty state with a route back to inbound work', () => {
    mockedUseReceivingContext.mockReturnValue(
      buildContextValue({
        receiptIdForQc: '',
        selectedQcLineId: '',
        selectedQcLine: undefined,
      }) as any,
    )

    renderPage('/receiving/qc')

    expect(screen.getByText('No receipts need QC right now')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to inbound work' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/receiving')
  })
})
