import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '../testUtils'
import { InventoryTransferCreatePage } from '@features/inventory/pages/InventoryTransferCreatePage'
import { waitFor } from '@testing-library/react'

vi.mock('@features/items/queries', () => ({
  useItemsList: vi.fn(),
}))
vi.mock('@features/locations/queries', () => ({
  useLocationsList: vi.fn(),
}))
vi.mock('@features/inventory/api/transfers', () => ({
  createInventoryTransfer: vi.fn(),
}))
vi.mock('@features/inventory/components/InventoryTransferForm', () => ({
  InventoryTransferForm: ({
    onChange,
    onSubmit,
  }: {
    onChange: (field: string, value: string) => void
    onSubmit: () => void
  }) => (
    <div>
      <button type="button" onClick={() => onSubmit()}>
        __submit_transfer__
      </button>
      <button
        type="button"
        onClick={() => {
          onChange('itemId', 'item-1')
          onChange('sourceLocationId', 'loc-1')
          onChange('destinationLocationId', 'loc-1')
          onChange('quantity', '2')
          onChange('uom', 'ea')
        }}
      >
        __set_same_location__
      </button>
      <button
        type="button"
        onClick={() => {
          onChange('itemId', 'item-1')
          onChange('sourceLocationId', 'loc-1')
          onChange('destinationLocationId', 'loc-2')
          onChange('quantity', '2')
          onChange('uom', 'ea')
        }}
      >
        __set_valid_transfer__
      </button>
    </div>
  ),
}))

import { useItemsList } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'
import { createInventoryTransfer } from '@features/inventory/api/transfers'

const mockedUseItemsList = vi.mocked(useItemsList)
const mockedUseLocationsList = vi.mocked(useLocationsList)
const mockedCreateInventoryTransfer = vi.mocked(createInventoryTransfer)

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: '/inventory-transfers/new',
        element: <InventoryTransferCreatePage />,
      },
    ],
    { initialEntries: ['/inventory-transfers/new'] },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('InventoryTransferCreatePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseItemsList.mockReturnValue({ data: { data: [] } } as any)
    mockedUseLocationsList.mockReturnValue({ data: { data: [] } } as any)
    mockedCreateInventoryTransfer.mockResolvedValue({
      transferId: 'transfer-1',
      movementId: 'movement-1',
      replayed: false,
    } as any)
  })

  it('shows a success alert after posting a transfer', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: '__set_valid_transfer__' }))
    fireEvent.click(screen.getByRole('button', { name: '__submit_transfer__' }))

    expect(await screen.findByText('Transfer posted')).toBeInTheDocument()
    expect(screen.getByText('Transfer ID: transfer-1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View movement' })).toBeInTheDocument()
  })

  it('blocks same-location transfers with actionable validation feedback', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: '__set_same_location__' }))
    fireEvent.click(screen.getByRole('button', { name: '__submit_transfer__' }))

    expect(await screen.findByText('Resolve transfer inputs')).toBeInTheDocument()
    expect(screen.getByText('Source and destination locations must differ.')).toBeInTheDocument()
    expect(mockedCreateInventoryTransfer).not.toHaveBeenCalled()
  })

  it('maps backend stock errors to actionable transfer messaging', async () => {
    mockedCreateInventoryTransfer.mockRejectedValueOnce({ message: 'INSUFFICIENT_STOCK' })

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: '__set_valid_transfer__' }))
    fireEvent.click(screen.getByRole('button', { name: '__submit_transfer__' }))

    await waitFor(() => {
      expect(mockedCreateInventoryTransfer).toHaveBeenCalled()
    })
    expect(
      await screen.findByText(
        'Insufficient stock is available at the source location. Reduce the quantity or replenish stock before posting the transfer.',
      ),
    ).toBeInTheDocument()
  })
})
