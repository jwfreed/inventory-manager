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
      all: ['return-receipts'],
      detail: (id: string) => ['return-receipts', 'detail', id],
    },
  },
  useReturnReceipt: vi.fn(),
  useReturn: vi.fn(),
  useReturnDispositionsList: vi.fn(),
}))

vi.mock('../../features/orderToCash/api/returnDispositions', () => ({
  createReturnDisposition: vi.fn(),
  postReturnDisposition: vi.fn(),
}))

vi.mock('../../features/orderToCash/api/returnReceipts', () => ({
  postReturnReceipt: vi.fn(),
}))

import {
  useReturn,
  useReturnDispositionsList,
  useReturnReceipt,
} from '../../features/orderToCash/queries'
import {
  createReturnDisposition,
  postReturnDisposition,
} from '../../features/orderToCash/api/returnDispositions'
import { postReturnReceipt } from '../../features/orderToCash/api/returnReceipts'

const mockedUseReturnReceipt = vi.mocked(useReturnReceipt)
const mockedUseReturn = vi.mocked(useReturn)
const mockedUseReturnDispositionsList = vi.mocked(useReturnDispositionsList)
const mockedCreateReturnDisposition = vi.mocked(createReturnDisposition)
const mockedPostReturnDisposition = vi.mocked(postReturnDisposition)
const mockedPostReturnReceipt = vi.mocked(postReturnReceipt)

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
    mockedPostReturnDisposition.mockResolvedValue({
      id: 'disp-1',
      returnReceiptId: 'receipt-1',
      status: 'posted',
    } as any)
    mockedPostReturnReceipt.mockResolvedValue({
      id: 'receipt-1',
      returnAuthorizationId: 'rma-1',
      status: 'posted',
    } as any)
  })

  it('blocks disposition creation until the receipt is posted', async () => {
    renderPage()

    expect(await screen.findByText('Return receipt')).toBeInTheDocument()
    expect(screen.getByText('Disposition locked')).toBeInTheDocument()
    expect(
      screen.getByText('Post the receipt before creating disposition drafts.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Post receipt to unlock' })).toBeDisabled()
  })

  it('posts the receipt explicitly', async () => {
    renderPage()

    expect(await screen.findByText('Return receipt')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Post receipt' }))

    await waitFor(() =>
      expect(mockedPostReturnReceipt).toHaveBeenCalledWith(
        'receipt-1',
        expect.stringMatching(/^return-receipt-post:/),
      ),
    )
  })

  it('creates a disposition draft from posted receipt lines', async () => {
    mockedUseReturnReceipt.mockReturnValue({
      data: {
        id: 'receipt-1',
        returnAuthorizationId: 'rma-1',
        status: 'posted',
        lines: [{ id: 'rrl-1', itemId: 'item-1', uom: 'ea', quantityReceived: 2 }],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()

    expect(await screen.findByText('Return receipt')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/From-location ID/i), { target: { value: 'loc-qa' } })
    fireEvent.change(screen.getByLabelText(/To-location ID/i), { target: { value: 'loc-sellable' } })
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create disposition draft' }))

    await waitFor(() =>
      expect(mockedCreateReturnDisposition).toHaveBeenCalledWith(
        expect.objectContaining({
          returnReceiptId: 'receipt-1',
          fromLocationId: 'loc-qa',
          toLocationId: 'loc-sellable',
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
    expect(mockedCreateReturnDisposition.mock.calls[0]?.[0]).not.toHaveProperty('inventoryMovementId')
  })

  it('posts a linked draft disposition explicitly', async () => {
    mockedUseReturnReceipt.mockReturnValue({
      data: {
        id: 'receipt-1',
        returnAuthorizationId: 'rma-1',
        status: 'posted',
        lines: [{ id: 'rrl-1', itemId: 'item-1', uom: 'ea', quantityReceived: 2 }],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
    mockedUseReturnDispositionsList.mockReturnValue({
      data: {
        data: [
          {
            id: 'disp-1',
            returnReceiptId: 'receipt-1',
            status: 'draft',
            dispositionType: 'restock',
            occurredAt: '2026-03-01T00:00:00.000Z',
            fromLocationId: 'loc-qa',
            toLocationId: null,
            inventoryMovementId: null,
          },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    } as any)

    renderPage()

    expect(await screen.findByText('Return receipt')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Post disposition' }))

    await waitFor(() =>
      expect(mockedPostReturnDisposition).toHaveBeenCalledWith(
        'disp-1',
        expect.stringMatching(/^return-disposition-post:/),
      ),
    )
  })
})
