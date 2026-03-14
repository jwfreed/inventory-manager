import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '../testUtils'
import PurchaseOrderDetailPage from '@features/purchaseOrders/pages/PurchaseOrderDetailPage'

vi.mock('@features/locations/queries', () => ({
  useLocationsList: vi.fn(),
}))
vi.mock('@features/purchaseOrders/queries', () => ({
  usePurchaseOrder: vi.fn(),
}))
vi.mock('@features/purchaseOrders/api/purchaseOrders', () => ({
  approvePurchaseOrder: vi.fn(),
  cancelPurchaseOrderApi: vi.fn(),
  closePurchaseOrder: vi.fn(),
  closePurchaseOrderLine: vi.fn(),
  updatePurchaseOrder: vi.fn(),
}))
vi.mock('../../app/layout/usePageChrome', () => ({
  usePageChrome: () => ({ hideTitle: false }),
}))
vi.mock('../../features/audit/queries', () => ({
  useAuditLog: () => ({ data: [], isLoading: false, isError: false }),
}))
vi.mock('../../features/audit/components/AuditTrailTable', () => ({
  AuditTrailTable: () => <div>__audit_trail__</div>,
}))

import { useLocationsList } from '@features/locations/queries'
import { usePurchaseOrder } from '@features/purchaseOrders/queries'

const mockedUseLocationsList = vi.mocked(useLocationsList)
const mockedUsePurchaseOrder = vi.mocked(usePurchaseOrder)

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: '/purchase-orders/:id',
        element: <PurchaseOrderDetailPage />,
      },
    ],
    { initialEntries: ['/purchase-orders/po-1'] },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('PurchaseOrderDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseLocationsList.mockReturnValue({ data: { data: [] }, isLoading: false } as any)
    mockedUsePurchaseOrder.mockReturnValue({
      data: {
        id: 'po-1',
        poNumber: 'PO-0001',
        vendorId: 'vendor-1',
        vendorCode: 'SUP-1',
        vendorName: 'Supplier',
        status: 'approved',
        shipToLocationId: 'loc-1',
        receivingLocationId: 'loc-2',
        lines: [
          {
            id: 'line-1',
            itemId: 'item-1',
            itemSku: 'RM-1',
            itemName: 'Raw Material',
            quantityOrdered: 10,
            quantityReceived: 0,
            status: 'open',
            uom: 'kg',
          },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
  })

  it('shows header and line close entrypoints for approved purchase orders', async () => {
    renderPage()

    expect(await screen.findByRole('button', { name: 'Close PO' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close line' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close PO' }))
    expect(screen.getByText('Close purchase order')).toBeInTheDocument()
  })
})
