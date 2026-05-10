import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '../testUtils'
import PurchaseOrderDetailPage from '@features/purchaseOrders/pages/PurchaseOrderDetailPage'

let authPermissions: string[] = ['purchasing:write', 'purchasing:void', 'purchasing:approve']

vi.mock('@shared/auth', () => ({
  useAuth: () => ({
    hasPermission: (permission: string) => authPermissions.includes(permission),
    permissions: authPermissions,
  }),
}))

vi.mock('@features/locations/queries', () => ({
  useLocationsList: vi.fn(),
}))
vi.mock('@features/purchaseOrders/queries', () => ({
  usePurchaseOrder: vi.fn(),
  purchaseOrdersQueryKeys: {
    all: ['purchase-orders'],
    detail: (id: string) => ['purchase-orders', 'detail', id],
  },
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
import { closePurchaseOrder } from '@features/purchaseOrders/api/purchaseOrders'

const mockedUseLocationsList = vi.mocked(useLocationsList)
const mockedUsePurchaseOrder = vi.mocked(usePurchaseOrder)
const mockedClosePurchaseOrder = vi.mocked(closePurchaseOrder)

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
    authPermissions = ['purchasing:write', 'purchasing:void', 'purchasing:approve']
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
    mockedClosePurchaseOrder.mockResolvedValue({
      id: 'po-1',
      poNumber: 'PO-0001',
      vendorId: 'vendor-1',
      vendorCode: 'SUP-1',
      vendorName: 'Supplier',
      status: 'closed',
      shipToLocationId: 'loc-1',
      receivingLocationId: 'loc-2',
      lines: [],
    } as any)
  })

  it('shows header and line close entrypoints for approved purchase orders', async () => {
    renderPage()

    expect(await screen.findByRole('button', { name: 'Close PO' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close line' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close PO' }))
    expect(screen.getByText('Close purchase order')).toBeInTheDocument()
  })

  it('approved PO shows exactly one Receive items link in the header area', async () => {
    renderPage()

    const receiveLinks = await screen.findAllByRole('link', { name: 'Receive items' })
    expect(receiveLinks).toHaveLength(1)
    expect(receiveLinks[0]).toHaveAttribute('href', '/receiving/receipt?poId=po-1')
  })

  it('approved banner is explanatory-only and does not contain a Receive items button', async () => {
    renderPage()

    expect(await screen.findByText('Approved purchase order')).toBeInTheDocument()
    expect(screen.getByText(/Receiving can now begin/)).toBeInTheDocument()

    // The banner itself should not contain a Receive items button
    const banner = screen.getByText('Approved purchase order').closest('div') as HTMLElement
    expect(banner).not.toHaveTextContent('Receive items')
  })

  it('lower action bar does not contain Receive items', async () => {
    renderPage()

    // Wait for page to settle
    await screen.findByText('PO PO-0001')

    // The only Receive items should be the header link — action bar should not add another
    const receiveLinks = screen.getAllByRole('link', { name: 'Receive items' })
    expect(receiveLinks).toHaveLength(1)
  })

  it('fully received PO does not show Receive items', async () => {
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
          { id: 'line-1', itemId: 'item-1', quantityOrdered: 10, quantityReceived: 10, status: 'complete', uom: 'kg' },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()

    await screen.findByText('PO PO-0001')
    expect(screen.queryByRole('link', { name: 'Receive items' })).toBeNull()
  })

  it('approved PO shows workflow guidance banner, not generic locked banner', async () => {
    renderPage()

    expect(await screen.findByText('Approved purchase order')).toBeInTheDocument()
    expect(screen.getByText(/This PO is read-only because it has been approved/)).toBeInTheDocument()
    expect(screen.queryByText('Locked')).toBeNull()
  })

  it('approved PO does not show Save draft button', async () => {
    renderPage()

    await screen.findByText('PO PO-0001')
    expect(screen.queryByRole('button', { name: /Save draft/ })).toBeNull()
  })

  it('lines table shows Ordered and Remaining columns with formatted quantities', async () => {
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
            quantityOrdered: 30000,
            quantityReceived: 9500,
            status: 'open',
            uom: 'g',
          },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()

    // Column headers
    expect(await screen.findByText('Ordered')).toBeInTheDocument()
    expect(screen.getByText('Remaining')).toBeInTheDocument()

    // Formatted quantities (no excessive decimals)
    expect(screen.getByText('30,000')).toBeInTheDocument()
    expect(screen.getByText('9,500')).toBeInTheDocument()
    // Remaining: 30000 - 9500 = 20500
    expect(screen.getByText('20,500')).toBeInTheDocument()
  })

  it('approved PO shows receiving progress summary above lines', async () => {
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
          { id: 'line-1', itemId: 'item-1', quantityOrdered: 10, quantityReceived: 0, status: 'open', uom: 'kg' },
          { id: 'line-2', itemId: 'item-2', quantityOrdered: 5, quantityReceived: 5, status: 'complete', uom: 'kg' },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()

    expect(await screen.findByText(/1 of 2 lines received/)).toBeInTheDocument()
    expect(screen.getByText(/1 line remaining/)).toBeInTheDocument()
  })

  it('draft PO shows Save draft button and not Receive items', async () => {
    mockedUsePurchaseOrder.mockReturnValue({
      data: {
        id: 'po-1',
        poNumber: 'PO-0001',
        vendorId: 'vendor-1',
        vendorCode: 'SUP-1',
        vendorName: 'Supplier',
        status: 'draft',
        shipToLocationId: 'loc-1',
        receivingLocationId: 'loc-2',
        lines: [
          { id: 'line-1', itemId: 'item-1', quantityOrdered: 10, quantityReceived: 0, status: 'open', uom: 'kg' },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()

    expect(await screen.findByRole('button', { name: 'Save draft' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Receive items' })).toBeNull()
  })

  it('closed PO does not show Receive items', async () => {
    mockedUsePurchaseOrder.mockReturnValue({
      data: {
        id: 'po-1',
        poNumber: 'PO-0001',
        vendorId: 'vendor-1',
        vendorCode: 'SUP-1',
        vendorName: 'Supplier',
        status: 'closed',
        shipToLocationId: 'loc-1',
        receivingLocationId: 'loc-2',
        lines: [],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()

    await screen.findByText('PO PO-0001')
    expect(screen.queryByRole('link', { name: 'Receive items' })).toBeNull()
  })

  it('confirms purchase order close and invalidates purchase order queries', async () => {
    const { queryClient } = renderPage()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    fireEvent.click(await screen.findByRole('button', { name: 'Close PO' }))
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Supplier confirmed closure' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm close' }))

    await waitFor(() => {
      expect(mockedClosePurchaseOrder).toHaveBeenCalledWith('po-1', {
        closeAs: 'closed',
        reason: 'Supplier confirmed closure',
        notes: undefined,
      })
    })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['purchase-orders'] })
  })

  it('surfaces backend close conflicts', async () => {
    mockedClosePurchaseOrder.mockRejectedValueOnce({ status: 409, message: 'Already closed' })

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Close PO' }))
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Duplicate close attempt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm close' }))

    expect(await screen.findByText('Already closed')).toBeInTheDocument()
  })

  it('hides purchase order mutation actions without write or void permissions', async () => {
    authPermissions = ['purchasing:read']

    renderPage()

    expect(await screen.findByText('Purchase Order PO-0001')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close PO' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close line' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New PO' })).toBeNull()
  })
})
