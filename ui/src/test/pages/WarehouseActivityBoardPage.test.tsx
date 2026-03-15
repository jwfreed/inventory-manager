import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { screen } from '@testing-library/react'
import { renderWithQueryClient } from '../testUtils'
import WarehouseActivityBoardPage from '../../features/inventory/pages/WarehouseActivityBoardPage'

vi.mock('@features/ledger/queries', () => ({
  useMovementsList: vi.fn(),
}))

vi.mock('@features/orderToCash/queries', () => ({
  useShipmentsList: vi.fn(),
  useReturnReceiptsList: vi.fn(),
  useReturnDispositionsList: vi.fn(),
}))

import { useMovementsList } from '@features/ledger/queries'
import {
  useReturnDispositionsList,
  useReturnReceiptsList,
  useShipmentsList,
} from '@features/orderToCash/queries'

const mockedUseMovementsList = vi.mocked(useMovementsList)
const mockedUseShipmentsList = vi.mocked(useShipmentsList)
const mockedUseReturnReceiptsList = vi.mocked(useReturnReceiptsList)
const mockedUseReturnDispositionsList = vi.mocked(useReturnDispositionsList)

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: '/inventory/activity',
        element: <WarehouseActivityBoardPage />,
      },
    ],
    { initialEntries: ['/inventory/activity'] },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('WarehouseActivityBoardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseMovementsList
      .mockReturnValueOnce({
        data: {
          data: [
            {
              id: 'move-transfer-1',
              status: 'posted',
              occurredAt: '2026-03-15T08:00:00.000Z',
              externalRef: 'transfer:tx-1',
            },
          ],
        },
        isLoading: false,
        isError: false,
        error: null,
      } as any)
      .mockReturnValueOnce({
        data: {
          data: [
            {
              id: 'move-prod-1',
              status: 'posted',
              occurredAt: '2026-03-15T09:00:00.000Z',
              externalRef: 'work_order_batch_completion:exec-1:wo-1',
            },
          ],
        },
        isLoading: false,
        isError: false,
        error: null,
      } as any)
    mockedUseShipmentsList.mockReturnValue({
      data: {
        data: [{ id: 'ship-1', status: 'posted', salesOrderId: 'so-1', shippedAt: '2026-03-15T10:00:00.000Z' }],
      },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUseReturnReceiptsList.mockReturnValue({
      data: {
        data: [{ id: 'receipt-1', status: 'draft', receivedAt: '2026-03-15T11:00:00.000Z' }],
      },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUseReturnDispositionsList.mockReturnValue({
      data: {
        data: [{ id: 'disp-1', status: 'draft', occurredAt: '2026-03-15T12:00:00.000Z', dispositionType: 'restock' }],
      },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
  })

  it('renders the warehouse activity panels from existing queries', async () => {
    renderPage()

    expect(await screen.findByText('Warehouse Activity')).toBeInTheDocument()
    expect(screen.getAllByText('Recent transfers')).toHaveLength(1)
    expect(screen.getByText('Transfer move-tra')).toBeInTheDocument()
    expect(screen.getByText('Production report exec-1 posted')).toBeInTheDocument()
    expect(screen.getByText('Shipment ship-1')).toBeInTheDocument()
    expect(screen.getByText('Receipt receipt-')).toBeInTheDocument()
  })
})
