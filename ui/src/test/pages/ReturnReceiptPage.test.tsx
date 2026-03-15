import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '../testUtils'
import ReturnReceiptPage from '../../features/orderToCash/pages/ReturnReceiptPage'

vi.mock('../../features/orderToCash/queries', () => ({
  orderToCashQueryKeys: {
    returnDispositions: {
      all: ['return-dispositions'],
    },
    returnReceipts: {
      detail: (id: string) => ['return-receipts', 'detail', id],
    },
  },
  useReturnReceipt: vi.fn(),
  useReturn: vi.fn(),
  useReturnDispositionsList: vi.fn(),
}))

vi.mock('../../features/orderToCash/api/returnDispositions', () => ({
  createReturnDisposition: vi.fn(),
}))

import {
  useReturn,
  useReturnDispositionsList,
  useReturnReceipt,
} from '../../features/orderToCash/queries'
import { createReturnDisposition } from '../../features/orderToCash/api/returnDispositions'

const mockedUseReturnReceipt = vi.mocked(useReturnReceipt)
const mockedUseReturn = vi.mocked(useReturn)
const mockedUseReturnDispositionsList = vi.mocked(useReturnDispositionsList)
const mockedCreateReturnDisposition = vi.mocked(createReturnDisposition)

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: '/return-receipts/:id',
        element: <ReturnReceiptPage />,
      },
      {
        path: '/not-found',
        element: <div>not found</div>,
      },
    ],
    { initialEntries: ['/return-receipts/receipt-1'] },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('ReturnReceiptPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseReturnReceipt.mockReturnValue({
      data: {
        id: 'receipt-1',
        returnAuthorizationId: 'rma-1',
        status: 'draft',
        lines: [{ id: 'rrl-1', itemId: 'item-1', uom: 'ea', quantityReceived: 2 }],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
    mockedUseReturn.mockReturnValue({
      data: { id: 'rma-1', rmaNumber: 'RMA-1' },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUseReturnDispositionsList.mockReturnValue({
      data: { data: [] },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedCreateReturnDisposition.mockResolvedValue({
      id: 'disp-1',
      returnReceiptId: 'receipt-1',
      status: 'draft',
    } as any)
  })

  it('creates a disposition from receipt lines', async () => {
    renderPage()

    expect(await screen.findByText('Return receipt')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/From-location ID/i), { target: { value: 'loc-qa' } })
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create disposition' }))

    await waitFor(() =>
      expect(mockedCreateReturnDisposition).toHaveBeenCalledWith(
        expect.objectContaining({
          returnReceiptId: 'receipt-1',
          fromLocationId: 'loc-qa',
          dispositionType: 'restock',
          lines: [
            expect.objectContaining({
              itemId: 'item-1',
              quantity: 2,
            }),
          ],
        }),
      ),
    )
  })
})
