import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '../testUtils'
import { InventoryTransferCreatePage } from '@features/inventory/pages/InventoryTransferCreatePage'

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
  InventoryTransferForm: ({ onSubmit }: { onSubmit: () => void }) => (
    <button type="button" onClick={onSubmit}>
      __submit_transfer__
    </button>
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

    fireEvent.click(await screen.findByRole('button', { name: '__submit_transfer__' }))

    expect(await screen.findByText('Transfer posted')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View movement' })).toBeInTheDocument()
  })
})
