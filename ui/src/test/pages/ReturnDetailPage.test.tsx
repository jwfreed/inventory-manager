import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '../testUtils'
import ReturnDetailPage from '../../features/orderToCash/pages/ReturnDetailPage'

vi.mock('../../features/orderToCash/queries', () => ({
  orderToCashQueryKeys: {
    returns: {
      detail: (id: string) => ['returns', 'detail', id],
    },
    returnReceipts: {
      all: ['return-receipts'],
    },
  },
  useReturn: vi.fn(),
  useReturnReceiptsList: vi.fn(),
}))

vi.mock('../../features/orderToCash/api/returnReceipts', () => ({
  createReturnReceipt: vi.fn(),
}))

import { useReturn, useReturnReceiptsList } from '../../features/orderToCash/queries'
import { createReturnReceipt } from '../../features/orderToCash/api/returnReceipts'

const mockedUseReturn = vi.mocked(useReturn)
const mockedUseReturnReceiptsList = vi.mocked(useReturnReceiptsList)
const mockedCreateReturnReceipt = vi.mocked(createReturnReceipt)

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: '/returns/:id',
        element: <ReturnDetailPage />,
      },
      {
        path: '/return-receipts/:id',
        element: <div>receipt detail</div>,
      },
      {
        path: '/not-found',
        element: <div>not found</div>,
      },
    ],
    { initialEntries: ['/returns/rma-1'] },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('ReturnDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseReturn.mockReturnValue({
      data: {
        id: 'rma-1',
        rmaNumber: 'RMA-1',
        status: 'authorized',
        customerId: 'cust-1',
        lines: [{ id: 'ral-1', lineNumber: 1, itemId: 'item-1', uom: 'ea', quantityAuthorized: 3 }],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
    mockedUseReturnReceiptsList.mockReturnValue({
      data: { data: [] },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedCreateReturnReceipt.mockResolvedValue({
      id: 'receipt-1',
      returnAuthorizationId: 'rma-1',
    } as any)
  })

  it('creates a return receipt from authorized lines', async () => {
    renderPage()

    expect(await screen.findByText('Return authorization')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Received-to location ID/i), { target: { value: 'loc-1' } })
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create return receipt' }))

    await waitFor(() =>
      expect(mockedCreateReturnReceipt).toHaveBeenCalledWith(
        expect.objectContaining({
          returnAuthorizationId: 'rma-1',
          receivedToLocationId: 'loc-1',
          lines: [
            expect.objectContaining({
              returnAuthorizationLineId: 'ral-1',
              itemId: 'item-1',
              quantityReceived: 2,
            }),
          ],
        }),
      ),
    )
    expect(mockedCreateReturnReceipt.mock.calls[0]?.[0]).not.toHaveProperty('inventoryMovementId')
  })
})
