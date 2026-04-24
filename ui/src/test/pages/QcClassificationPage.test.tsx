import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
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

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: '/receiving/qc/:receiptId',
        element: <QcClassificationPage />,
      },
    ],
    { initialEntries: ['/receiving/qc/receipt-1'] },
  )

  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('QcClassificationPage keyboard shortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseReceivingContext.mockReturnValue({
      receiptIdForQc: 'receipt-1',
      loadReceiptForQc: vi.fn(),
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
    } as any)
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
})
