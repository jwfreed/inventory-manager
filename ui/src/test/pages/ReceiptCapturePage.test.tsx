import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { renderWithQueryClient } from '../testUtils'
import ReceiptCapturePage from '../../features/receiving/pages/ReceiptCapturePage'
import { useReceivingContext } from '../../features/receiving/context'
import type { ReceiptLineInput, ReceiptLineSummary } from '../../features/receiving/types'
import { parseReceiptQuantityForValidation } from '../../features/receiving/utils'

vi.mock('@shared/auth', () => ({
  useAuth: () => ({ user: { fullName: 'Receiver One', email: 'receiver@example.com' } }),
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

const mockedUseReceivingContext = vi.mocked(useReceivingContext)

const locationId = '75ec0000-1111-4222-8333-123456789abc'

const receiptLines: ReceiptLineInput[] = [
  {
    purchaseOrderLineId: 'po-line-1',
    lineNumber: 1,
    itemLabel: 'COCOA — Cocoa powder',
    uom: 'g',
    expectedQty: 30000,
    receivedQty: 30000,
    discrepancyReason: '',
    discrepancyNotes: '',
  },
  {
    purchaseOrderLineId: 'po-line-2',
    lineNumber: 2,
    itemLabel: 'SUGAR — Sugar',
    uom: 'g',
    expectedQty: 46000,
    receivedQty: 46000,
    discrepancyReason: '',
    discrepancyNotes: '',
  },
  {
    purchaseOrderLineId: 'po-line-3',
    lineNumber: 3,
    itemLabel: 'BOX — Retail box',
    uom: 'each',
    expectedQty: 1000,
    receivedQty: 1000,
    discrepancyReason: '',
    discrepancyNotes: '',
  },
]

const buildSummary = (lines = receiptLines): ReceiptLineSummary => {
  const summaryLines = lines.map((line) => {
    const received = parseReceiptQuantityForValidation(line.receivedQty)
    const receivedQty = received.value
    const expectedQty = Number(line.expectedQty)
    return {
      ...line,
      receivedQty,
      expectedQty,
      delta: receivedQty - expectedQty,
      remaining: Math.max(0, expectedQty - receivedQty),
      invalidQuantity: !received.valid,
    }
  })
  return {
    lines: summaryLines,
    receivedLines: summaryLines.filter((line) => line.receivedQty > 0),
    discrepancyLines: summaryLines.filter((line) => line.delta !== 0),
    missingReasons: [],
    invalidLines: summaryLines.filter((line) => line.invalidQuantity || line.receivedQty < 0),
    missingLotSerial: [],
    overApprovalMissing: [],
    remainingLines: summaryLines.filter((line) => line.remaining > 0),
    totalExpected: summaryLines.reduce((sum, line) => sum + line.expectedQty, 0),
    totalReceived: summaryLines.reduce((sum, line) => sum + line.receivedQty, 0),
  }
}

const buildContextValue = (overrides: Record<string, unknown> = {}) => ({
  selectedPoId: 'po-1',
  handlePoChange: vi.fn(),
  poOptions: [{ value: 'po-1', label: 'PO-MILK-CHOC-1000-INGREDIENTS' }],
  poQuery: {
    data: {
      id: 'po-1',
      poNumber: 'PO-MILK-CHOC-1000-INGREDIENTS',
      status: 'approved',
      expectedDate: '2026-05-11',
      vendorCode: 'VEN',
      vendorName: 'Vendor',
      shipToLocationCode: 'MAIN',
      shipToLocationName: 'Main Warehouse',
      receivingLocationCode: 'MAIN',
      receivingLocationName: 'Main Warehouse',
      receivingLocationId: locationId,
      shipToLocationId: 'ship-to-1',
      updatedAt: '2026-05-11T00:00:00Z',
      lines: receiptLines,
    },
    refetch: vi.fn(),
  },
  receiptLineInputs: receiptLines,
  setReceiptLineInputs: vi.fn(),
  resetReceiptLines: vi.fn(),
  receiptLineSummary: buildSummary(),
  receiptMutation: {
    isPending: false,
    isSuccess: false,
    isError: false,
    data: null,
    error: null,
    reset: vi.fn(),
  },
  canPostReceipt: true,
  resolvedReceivedToLocationId: locationId,
  setReceivedToLocationId: vi.fn(),
  locationOptions: [{ value: locationId, label: 'MAIN — Main Warehouse' }],
  receiptNotes: '',
  setReceiptNotes: vi.fn(),
  onCreateReceipt: vi.fn((event) => event.preventDefault()),
  recentReceiptsQuery: { data: { data: [] } },
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
  ...overrides,
})

function renderPage() {
  return renderWithQueryClient(
    <MemoryRouter initialEntries={['/receiving/receipt?poId=po-1']}>
      <ReceiptCapturePage />
    </MemoryRouter>,
  )
}

describe('ReceiptCapturePage receipt capture display', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseReceivingContext.mockReturnValue(buildContextValue() as any)
  })

  it('shows a grouped receipt quantity summary and keeps post receipt available', () => {
    renderPage()

    expect(screen.getByText('76,000 g + 1,000 each ready to post')).toBeInTheDocument()
    expect(screen.queryByText(/030000\.0000020000/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Post receipt/i })).toBeEnabled()
  })

  it('hides the raw receiving location UUID in the main operator view', () => {
    renderPage()

    expect(screen.getByDisplayValue('MAIN — Main Warehouse')).toBeInTheDocument()
    expect(screen.queryByText(/Selected:/)).not.toBeInTheDocument()
    expect(screen.queryByText(locationId)).not.toBeInTheDocument()
  })

  it('keeps Receive all expected wired to populate expected quantities', () => {
    const setReceiptLineInputs = vi.fn()
    mockedUseReceivingContext.mockReturnValue(
      buildContextValue({ setReceiptLineInputs }) as any,
    )

    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Receive all expected' }))

    expect(setReceiptLineInputs).toHaveBeenCalledTimes(1)
    const updater = setReceiptLineInputs.mock.calls[0][0]
    const next = updater([
      { ...receiptLines[0], receivedQty: 0, discrepancyReason: 'short' },
    ])
    expect(next[0]).toMatchObject({ receivedQty: 30000, discrepancyReason: '' })
  })

  it('does not make Post receipt available when a quantity is invalid', () => {
    const invalidSummary = buildSummary(receiptLines)
    invalidSummary.invalidLines = [{ ...invalidSummary.lines[0], invalidQuantity: true }]
    mockedUseReceivingContext.mockReturnValue(
      buildContextValue({
        receiptLineSummary: invalidSummary,
        canPostReceipt: false,
      }) as any,
    )

    renderPage()

    expect(screen.getByRole('button', { name: /Post receipt/i })).toBeDisabled()
  })

  it('distinguishes receipt readiness from posted workflow completion', () => {
    renderPage()

    expect(screen.getByText('Posted Workflow Progress')).toBeInTheDocument()
    expect(screen.getAllByText(/Receipt capture: ready to post/i).length).toBeGreaterThan(0)
    expect(screen.getByText('QC classification')).toBeInTheDocument()
    expect(screen.getByText('Putaway planning')).toBeInTheDocument()
    expect(screen.getAllByText('not started').length).toBeGreaterThanOrEqual(2)
  })

  it('keeps empty receipt history visible but compact', () => {
    renderPage()

    expect(screen.getByText('Receipt history')).toBeInTheDocument()
    expect(screen.getByText('No receipts posted for this PO yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View all' })).toBeInTheDocument()
  })

  it('keeps receipt notes in the form', () => {
    const setReceiptNotes = vi.fn()
    mockedUseReceivingContext.mockReturnValue(
      buildContextValue({ setReceiptNotes }) as any,
    )

    renderPage()
    fireEvent.change(screen.getByLabelText(/Notes/i), { target: { value: 'Packaging dented' } })

    expect(setReceiptNotes).toHaveBeenCalledWith('Packaging dented')
  })
})
