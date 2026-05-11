import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { renderWithQueryClient } from '../testUtils'
import PutawayPlanningPage from '../../features/receiving/pages/PutawayPlanningPage'
import { useReceivingContext } from '../../features/receiving/context'

vi.mock('@shared/auth', () => ({
  useAuth: () => ({ user: { fullName: 'Putaway One', email: 'putaway@example.com' } }),
}))
vi.mock('../../features/receiving/context', () => ({
  useReceivingContext: vi.fn(),
}))
vi.mock('../../features/receiving/hooks/useResponsive', () => ({
  useResponsive: () => ({ isMobile: false }),
}))
vi.mock('../../features/receiving/components/ReceivingLayout', () => ({
  ReceivingLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('../../features/receiving/components/DraggablePutawayLinesEditor', () => ({
  DraggablePutawayLinesEditor: () => <div>putaway-lines-editor</div>,
}))
vi.mock('../../features/receiving/components/PutawaySummaryTable', () => ({
  PutawaySummaryTable: () => <div>putaway-summary</div>,
}))
vi.mock('../../features/receiving/components/ReceiptDocument', () => ({
  ReceiptDocument: () => <div>receipt-document</div>,
}))
vi.mock('../../features/receiving/components/KeyboardShortcutsModal', () => ({
  default: () => <div>shortcuts-modal</div>,
}))

const mockedUseReceivingContext = vi.mocked(useReceivingContext)

const completedPutaway = {
  id: 'putaway-123e4567-e89b-12d3-a456-426614174000',
  putawayNumber: 'PA-1001',
  status: 'completed',
  sourceType: 'purchase_order_receipt',
  purchaseOrderReceiptId: 'receipt-1',
  receiptNumber: 'R-1001',
  purchaseOrderNumber: 'PO-MILK-CHOC-1000-INGREDIENTS',
  completedAt: '2026-05-11T08:00:00Z',
  completedByName: 'Putaway One',
  lines: [
    {
      id: 'putaway-line-1',
      lineNumber: 1,
      purchaseOrderReceiptLineId: 'receipt-line-1',
      itemId: 'item-1',
      itemSku: 'COCOA',
      itemName: 'Cocoa powder',
      uom: 'g',
      quantityPlanned: 30000,
      quantityMoved: 30000,
      fromLocationId: 'stage-1',
      toLocationId: 'bulk-1',
      toLocationCode: 'BULK-1',
      status: 'completed',
    },
  ],
}

const buildContextValue = (overrides: Record<string, unknown> = {}) => ({
  putawayQuery: {
    data: completedPutaway,
    isLoading: false,
    isError: false,
    error: null,
  },
  postPutawayMutation: {
    data: null,
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    mutate: vi.fn(),
  },
  receiptQuery: {
    data: {
      id: 'receipt-1',
      receiptNumber: 'R-1001',
      purchaseOrderId: 'po-1',
      purchaseOrderNumber: 'PO-MILK-CHOC-1000-INGREDIENTS',
      status: 'posted',
      receivedAt: '2026-05-11T00:00:00Z',
      lines: [
        {
          id: 'receipt-line-1',
          purchaseOrderReceiptId: 'receipt-1',
          purchaseOrderLineId: 'po-line-1',
          itemSku: 'COCOA',
          itemName: 'Cocoa powder',
          quantityReceived: 30000,
          expectedQuantity: 30000,
          uom: 'g',
          qcSummary: {
            remainingUninspectedQuantity: 0,
            breakdown: { accept: 30000, hold: 0, reject: 0 },
          },
        },
      ],
    },
  },
  putawayId: completedPutaway.id,
  putawayLines: [],
  setPutawayLines: vi.fn(),
  canCreatePutaway: true,
  putawayReady: true,
  putawayMutation: { isPending: false, isSuccess: false, isError: false, error: null },
  receiptLineOptions: [],
  locationOptions: [],
  locationsQuery: { isLoading: false },
  fillPutawayFromReceipt: vi.fn(),
  resolvePutawayDefaults: vi.fn(() => ({ fromId: '', toId: '' })),
  setLocationSearch: vi.fn(),
  onCreatePutaway: vi.fn((event) => event.preventDefault()),
  putawayFillNotice: null,
  putawayResumeNotice: null,
  putawayQcIssues: [],
  putawayQuantityIssues: [],
  putawayBlockingLine: undefined,
  putawayHasAvailable: true,
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
  setSelectedPoId: vi.fn(),
  setReceiptIdForQc: vi.fn(),
  setPutawayId: vi.fn(),
  updateReceivingParams: vi.fn(),
  ...overrides,
})

function renderPage() {
  return renderWithQueryClient(
    <MemoryRouter initialEntries={['/receiving/putaway?receiptId=receipt-1&putawayId=putaway-1']}>
      <PutawayPlanningPage />
    </MemoryRouter>,
  )
}

describe('PutawayPlanningPage workflow completion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseReceivingContext.mockReturnValue(buildContextValue() as any)
  })

  it('shows inbound workflow completion after putaway is complete', () => {
    renderPage()

    expect(screen.getByText('Inbound workflow complete')).toBeInTheDocument()
    expect(screen.getByText(/Accepted inventory has been stored/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Post putaway/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to receiving queue' })).toBeInTheDocument()
  })

  it('explains that QC acceptance is required before putaway is available', () => {
    mockedUseReceivingContext.mockReturnValue(
      buildContextValue({
        putawayQuery: {
          data: null,
          isLoading: false,
          isError: false,
          error: null,
        },
        putawayId: '',
        putawayReady: false,
        putawayHasAvailable: false,
        receiptQuery: {
          data: {
            id: 'receipt-1',
            receiptNumber: 'R-1001',
            purchaseOrderId: 'po-1',
            status: 'posted',
            receivedAt: '2026-05-11T00:00:00Z',
            lines: [
              {
                id: 'receipt-line-1',
                purchaseOrderReceiptId: 'receipt-1',
                purchaseOrderLineId: 'po-line-1',
                itemSku: 'COCOA',
                itemName: 'Cocoa powder',
                quantityReceived: 30000,
                expectedQuantity: 30000,
                uom: 'g',
                qcSummary: {
                  remainingUninspectedQuantity: 30000,
                  breakdown: { accept: 0, hold: 0, reject: 0 },
                },
              },
            ],
          },
        },
      }) as any,
    )

    renderPage()

    expect(screen.getByText('Putaway not available')).toBeInTheDocument()
    expect(screen.getByText('Complete QC classification and accept inventory before putaway.')).toBeInTheDocument()
  })
})
