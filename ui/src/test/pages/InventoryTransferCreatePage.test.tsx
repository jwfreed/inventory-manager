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
    value,
    onChange,
    onSubmit,
  }: {
    value: Record<string, string>
    onChange: (field: string, value: string) => void
    onSubmit: () => void
  }) => (
    <div>
      <div data-testid="transfer-form-values">{JSON.stringify(value)}</div>
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

function renderPage(initialEntry = '/inventory-transfers/new') {
  const router = createMemoryRouter(
    [
      {
        path: '/inventory-transfers/new',
        element: <InventoryTransferCreatePage />,
      },
    ],
    { initialEntries: [initialEntry] },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('InventoryTransferCreatePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseItemsList.mockReturnValue({ data: { data: [] } } as unknown as ReturnType<typeof useItemsList>)
    mockedUseLocationsList.mockReturnValue({ data: { data: [] } } as unknown as ReturnType<typeof useLocationsList>)
    mockedCreateInventoryTransfer.mockResolvedValue({
      transferId: 'transfer-1',
      movementId: 'movement-1',
      replayed: false,
    } as Awaited<ReturnType<typeof createInventoryTransfer>>)
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

  it('uses stock transfer copy and opens with work-order shortage prefill', async () => {
    renderPage(
      '/inventory-transfers/new?itemId=item-1&fromLocationId=loc-1&toLocationId=loc-2&quantity=10&uom=each&referenceType=work_order&referenceId=WO-000017',
    )

    expect(await screen.findByText('New stock transfer')).toBeInTheDocument()
    expect(
      screen.getByText('Move stock between locations without changing total quantity.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Transfer preview')).toBeInTheDocument()
    expect(screen.getByText('Net item change: 0 each')).toBeInTheDocument()

    const values = JSON.parse(screen.getByTestId('transfer-form-values').textContent ?? '{}')
    expect(values).toMatchObject({
      itemId: 'item-1',
      sourceLocationId: 'loc-1',
      destinationLocationId: 'loc-2',
      quantity: '10',
      uom: 'each',
      referenceType: 'work_order',
      referenceId: 'WO-000017',
    })
  })

  it('links back to the inventory operations landing page', async () => {
    renderPage()

    const backLink = await screen.findByRole('link', { name: 'Back to operations' })
    expect(backLink).toHaveAttribute('href', '/inventory/operations')
    expect(screen.queryByRole('link', { name: 'Inventory counts' })).not.toBeInTheDocument()
  })
})
