import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { renderWithQueryClient } from '../testUtils'
import ReceivingPage from '../../features/receiving/pages/ReceivingPage'
import { usePurchaseOrdersList } from '@features/purchaseOrders/queries'
import { useReceiptsList } from '../../features/receiving/queries'

vi.mock('@features/purchaseOrders/queries', () => ({
  usePurchaseOrdersList: vi.fn(),
}))

vi.mock('../../features/receiving/queries', () => ({
  useReceiptsList: vi.fn(),
}))

const mockedUsePurchaseOrdersList = vi.mocked(usePurchaseOrdersList)
const mockedUseReceiptsList = vi.mocked(useReceiptsList)

const poId = 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa'
const receiptPendingQcId = 'bbbbbbbb-1111-4222-8333-bbbbbbbbbbbb'
const receiptPutawayId = 'cccccccc-1111-4222-8333-cccccccccccc'
const receiptCompleteId = 'dddddddd-1111-4222-8333-dddddddddddd'

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}{location.search}</div>
}

const approvedPo = {
  id: poId,
  poNumber: 'PO-MILK-CHOC-1000-INGREDIENTS',
  vendorId: 'vendor-1',
  vendorName: 'Siamaya Foods',
  status: 'approved',
  expectedDate: '2026-05-11',
  lines: [
    { id: 'po-line-1', quantityOrdered: 30000, uom: 'g' },
    { id: 'po-line-2', quantityOrdered: 46000, uom: 'g' },
  ],
}

const pendingQcReceipt = {
  id: receiptPendingQcId,
  receiptNumber: 'R-002220',
  purchaseOrderId: 'po-received-1',
  purchaseOrderNumber: 'PO-RECEIVED-1',
  vendorName: 'Cocoa Supplier',
  status: 'posted',
  workflowStatus: 'pending_qc',
  receivedAt: '2026-05-11T08:00:00Z',
  lines: [
    {
      id: 'receipt-line-1',
      purchaseOrderReceiptId: receiptPendingQcId,
      purchaseOrderLineId: 'po-line-r1',
      quantityReceived: 76000,
      uom: 'g',
      qcSummary: {
        totalQcQuantity: 0,
        remainingUninspectedQuantity: 76000,
        breakdown: { accept: 0, hold: 0, reject: 0 },
      },
    },
  ],
}

const putawayReadyReceipt = {
  id: receiptPutawayId,
  receiptNumber: 'R-002221',
  purchaseOrderId: 'po-received-2',
  purchaseOrderNumber: 'PO-RECEIVED-2',
  vendorName: 'Packaging Supplier',
  status: 'posted',
  workflowStatus: 'qc_passed',
  putawayStatus: 'not_started',
  receivedAt: '2026-05-11T09:00:00Z',
  totalAccepted: 1000,
  qcRemaining: 0,
  lines: [
    {
      id: 'receipt-line-2',
      purchaseOrderReceiptId: receiptPutawayId,
      purchaseOrderLineId: 'po-line-r2',
      quantityReceived: 1000,
      uom: 'each',
      availableForNewPutaway: 1000,
      qcSummary: {
        totalQcQuantity: 1000,
        remainingUninspectedQuantity: 0,
        breakdown: { accept: 1000, hold: 0, reject: 0 },
      },
    },
  ],
}

const completedReceipt = {
  id: receiptCompleteId,
  receiptNumber: 'R-002222',
  purchaseOrderId: 'po-complete-1',
  purchaseOrderNumber: 'PO-COMPLETE-1',
  vendorName: 'Finished Supplier',
  status: 'posted',
  workflowStatus: 'complete',
  putawayStatus: 'complete',
  receivedAt: '2026-05-11T10:00:00Z',
  lines: [],
}

function renderPage() {
  return renderWithQueryClient(
    <MemoryRouter initialEntries={['/receiving']}>
      <ReceivingPage />
      <LocationProbe />
    </MemoryRouter>,
  )
}

describe('ReceivingPage inbound workflow queue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUsePurchaseOrdersList.mockReturnValue({
      data: { data: [approvedPo] },
      isLoading: false,
      isError: false,
    } as any)
    mockedUseReceiptsList.mockReturnValue({
      data: { data: [pendingQcReceipt, putawayReadyReceipt, completedReceipt] },
      isLoading: false,
      isError: false,
    } as any)
  })

  it('shows approved POs awaiting receipt with Receive goods as the primary action', () => {
    renderPage()

    expect(screen.getByText('Receiving & QC')).toBeInTheDocument()
    expect(screen.getByText('PO-MILK-CHOC-1000-INGREDIENTS')).toBeInTheDocument()
    expect(screen.getByText('Awaiting receipt')).toBeInTheDocument()
    expect(screen.getByText('2 lines expected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Receive goods' })).toBeInTheDocument()
    expect(screen.queryByText(poId)).not.toBeInTheDocument()
  })

  it('routes awaiting-receipt work to receipt capture with the PO selected', () => {
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Receive goods' }))

    expect(screen.getByTestId('location')).toHaveTextContent(`/receiving/receipt?poId=${poId}`)
  })

  it('shows posted receipts awaiting QC with Continue QC and readable quantities', () => {
    renderPage()

    expect(screen.getByText('Receipt R-002220')).toBeInTheDocument()
    expect(screen.getByText('QC pending')).toBeInTheDocument()
    expect(screen.getByText('76,000 g received · 0 accepted')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue QC' })).toBeInTheDocument()
    expect(screen.queryByText(receiptPendingQcId)).not.toBeInTheDocument()
  })

  it('shows QC-complete accepted receipts awaiting putaway with Plan putaway', () => {
    renderPage()

    expect(screen.getByText('Receipt R-002221')).toBeInTheDocument()
    expect(screen.getByText('Putaway ready')).toBeInTheDocument()
    expect(screen.getByText('1,000 each accepted')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Plan putaway' })).toBeInTheDocument()
  })

  it('hides completed inbound work by default and marks it complete when shown', () => {
    renderPage()

    expect(screen.queryByText('Receipt R-002222')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show completed' }))

    expect(screen.getByText('Receipt R-002222')).toBeInTheDocument()
    expect(screen.getByText('Inbound complete')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View receipt' })).toBeInTheDocument()
  })
})
