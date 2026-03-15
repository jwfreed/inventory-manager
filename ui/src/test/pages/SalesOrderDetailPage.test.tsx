import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '../testUtils'
import SalesOrderDetailPage from '../../features/orderToCash/pages/SalesOrderDetailPage'

vi.mock('../../features/orderToCash/queries', () => ({
  orderToCashQueryKeys: {
    salesOrders: {
      all: ['sales-orders'],
      detail: (id: string) => ['sales-orders', 'detail', id],
    },
    shipments: {
      all: ['shipments'],
      detail: (id: string) => ['shipments', 'detail', id],
    },
    reservations: {
      all: ['reservations'],
    },
  },
  useSalesOrder: vi.fn(),
  useShipmentsList: vi.fn(),
  useReservationsList: vi.fn(),
}))

vi.mock('../../features/orderToCash/api/shipments', () => ({
  createShipment: vi.fn(),
}))

vi.mock('../../features/orderToCash/api/reservations', () => ({
  allocateReservation: vi.fn(),
}))

import {
  useReservationsList,
  useSalesOrder,
  useShipmentsList,
} from '../../features/orderToCash/queries'
import { createShipment } from '../../features/orderToCash/api/shipments'
import { allocateReservation } from '../../features/orderToCash/api/reservations'

const mockedUseSalesOrder = vi.mocked(useSalesOrder)
const mockedUseShipmentsList = vi.mocked(useShipmentsList)
const mockedUseReservationsList = vi.mocked(useReservationsList)
const mockedCreateShipment = vi.mocked(createShipment)
const mockedAllocateReservation = vi.mocked(allocateReservation)

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: '/sales-orders/:id',
        element: <SalesOrderDetailPage />,
      },
      {
        path: '/not-found',
        element: <div>not found</div>,
      },
    ],
    { initialEntries: ['/sales-orders/so-1'] },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('SalesOrderDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseSalesOrder.mockReturnValue({
      data: {
        id: 'so-1',
        soNumber: 'SO-1001',
        customerId: 'cust-1',
        status: 'submitted',
        warehouseId: 'wh-1',
        shipFromLocationId: 'loc-ship',
        lines: [
          {
            id: 'sol-1',
            lineNumber: 1,
            itemId: 'item-1',
            uom: 'ea',
            quantityOrdered: 5,
            derivedBackorderQty: 0,
          },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUseShipmentsList.mockReturnValue({
      data: { data: [] },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUseReservationsList.mockReturnValue({
      data: {
        data: [
          {
            id: 'res-1',
            demandType: 'sales_order_line',
            demandId: 'sol-1',
            status: 'RESERVED',
            itemId: 'item-1',
            warehouseId: 'wh-1',
            quantityReserved: 5,
            quantityFulfilled: 0,
          },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedCreateShipment.mockResolvedValue({
      id: 'ship-1',
      salesOrderId: 'so-1',
      status: 'draft',
    } as any)
    mockedAllocateReservation.mockResolvedValue({
      id: 'res-1',
      status: 'ALLOCATED',
    } as any)
  })

  it('creates a shipment from selected lines and allocates matching reserved inventory', async () => {
    renderPage()

    expect(await screen.findByText('Sales order detail')).toBeInTheDocument()

    fireEvent.change(screen.getByDisplayValue('loc-ship'), { target: { value: 'loc-ship' } })
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create shipment' }))

    await waitFor(() =>
      expect(mockedCreateShipment).toHaveBeenCalledWith(
        expect.objectContaining({
          salesOrderId: 'so-1',
          shipFromLocationId: 'loc-ship',
          lines: [{ salesOrderLineId: 'sol-1', uom: 'ea', quantityShipped: 3 }],
        }),
      ),
    )
    await waitFor(() => expect(mockedAllocateReservation).toHaveBeenCalledWith('res-1', 'wh-1'))
    expect(await screen.findByRole('button', { name: 'Open shipment' })).toBeInTheDocument()
  })
})
