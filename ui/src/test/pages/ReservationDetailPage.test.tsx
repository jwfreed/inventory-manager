import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '../testUtils'
import ReservationDetailPage from '../../features/orderToCash/pages/ReservationDetailPage'

vi.mock('../../features/orderToCash/queries', () => ({
  orderToCashQueryKeys: {
    reservations: {
      all: ['reservations'],
      detail: (id: string) => ['reservations', 'detail', id],
    },
    salesOrders: {
      all: ['sales-orders'],
    },
    shipments: {
      all: ['shipments'],
      detail: (id: string) => ['shipments', 'detail', id],
    },
  },
  useReservation: vi.fn(),
  useShipmentsList: vi.fn(),
}))

vi.mock('../../features/orderToCash/api/reservations', () => ({
  allocateReservation: vi.fn(),
  cancelReservation: vi.fn(),
  fulfillReservation: vi.fn(),
}))

vi.mock('../../features/orderToCash/api/shipments', () => ({
  getShipment: vi.fn(),
}))

import { useReservation, useShipmentsList } from '../../features/orderToCash/queries'
import { fulfillReservation } from '../../features/orderToCash/api/reservations'
import { getShipment } from '../../features/orderToCash/api/shipments'

const mockedUseReservation = vi.mocked(useReservation)
const mockedUseShipmentsList = vi.mocked(useShipmentsList)
const mockedFulfillReservation = vi.mocked(fulfillReservation)
const mockedGetShipment = vi.mocked(getShipment)

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: '/reservations/:id',
        element: <ReservationDetailPage />,
      },
      {
        path: '/not-found',
        element: <div>not found</div>,
      },
    ],
    { initialEntries: ['/reservations/res-1'] },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('ReservationDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseReservation.mockReturnValue({
      data: {
        id: 'res-1',
        status: 'ALLOCATED',
        demandType: 'sales_order_line',
        demandId: 'sol-1',
        itemId: 'item-1',
        locationId: 'loc-1',
        warehouseId: 'wh-1',
        uom: 'ea',
        quantityReserved: 5,
        quantityFulfilled: 1,
        reservedAt: '2026-03-15T08:00:00.000Z',
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
    mockedUseShipmentsList.mockReturnValue({
      data: {
        data: [{ id: 'ship-1', salesOrderId: 'so-1' }],
      },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedGetShipment.mockResolvedValue({
      id: 'ship-1',
      status: 'posted',
      shippedAt: '2026-03-15T09:00:00.000Z',
      inventoryMovementId: 'move-1',
      lines: [{ id: 'line-1', salesOrderLineId: 'sol-1', quantityShipped: 4, uom: 'ea' }],
    } as any)
    mockedFulfillReservation.mockResolvedValue({
      id: 'res-1',
      status: 'FULFILLED',
      warehouseId: 'wh-1',
    } as any)
  })

  it('shows recent shipment linkage and fulfills the reservation from the modal', async () => {
    renderPage()

    expect(await screen.findByText('Reservation detail')).toBeInTheDocument()
    expect(await screen.findByText('ship-1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Fulfill reservation' }))
    const quantityInput = await screen.findByDisplayValue('4')
    fireEvent.change(quantityInput, { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm fulfill' }))

    await waitFor(() =>
      expect(mockedFulfillReservation).toHaveBeenCalledWith('res-1', {
        warehouseId: 'wh-1',
        quantity: 3,
      }),
    )
  })
})
