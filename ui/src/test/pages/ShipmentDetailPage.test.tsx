import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '../testUtils'
import ShipmentDetailPage from '../../features/orderToCash/pages/ShipmentDetailPage'

vi.mock('../../features/orderToCash/queries', () => ({
  orderToCashQueryKeys: {
    shipments: {
      all: ['shipments'],
      detail: (id: string) => ['shipments', 'detail', id],
    },
    reservations: {
      all: ['reservations'],
    },
    salesOrders: {
      all: ['sales-orders'],
      detail: (id: string) => ['sales-orders', 'detail', id],
    },
  },
  useShipment: vi.fn(),
}))

vi.mock('../../features/orderToCash/api/shipments', () => ({
  postShipment: vi.fn(),
}))

vi.mock('@features/ledger/queries', () => ({
  ledgerQueryKeys: {
    all: ['movements'],
  },
}))

import { useShipment } from '../../features/orderToCash/queries'
import { postShipment } from '../../features/orderToCash/api/shipments'

const mockedUseShipment = vi.mocked(useShipment)
const mockedPostShipment = vi.mocked(postShipment)

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: '/shipments/:id',
        element: <ShipmentDetailPage />,
      },
      {
        path: '/not-found',
        element: <div>not found</div>,
      },
    ],
    { initialEntries: ['/shipments/ship-1'] },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('ShipmentDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseShipment.mockReturnValue({
      data: {
        id: 'ship-1',
        salesOrderId: 'so-1',
        status: 'draft',
        shippedAt: '2026-03-15T10:00:00.000Z',
        shipFromLocationId: 'loc-ship',
        lines: [{ id: 'line-1', salesOrderLineId: 'sol-1', uom: 'ea', quantityShipped: 4 }],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
    mockedPostShipment.mockResolvedValue({
      id: 'ship-1',
      salesOrderId: 'so-1',
      status: 'posted',
      inventoryMovementId: 'move-1',
    } as any)
  })

  it('posts the shipment from the confirmation modal', async () => {
    renderPage()

    expect(await screen.findByText('Shipment detail')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Post shipment' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm post' }))

    await waitFor(() => expect(mockedPostShipment).toHaveBeenCalledWith('ship-1'))
  })
})
