import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '../testUtils'
import InventoryCountCreatePage from '@features/inventory/pages/InventoryCountCreatePage'

vi.mock('@features/items/queries', () => ({
  useItemsList: vi.fn(),
}))
vi.mock('@features/locations/queries', () => ({
  useLocationsList: vi.fn(),
}))
vi.mock('@features/inventory/api/counts', () => ({
  createInventoryCount: vi.fn(),
}))
vi.mock('@features/inventory/components/InventoryCountForm', () => ({
  InventoryCountForm: ({ onSubmit }: { onSubmit: () => void }) => (
    <button type="button" onClick={onSubmit}>
      __create_count__
    </button>
  ),
  createEmptyInventoryCountLine: () => ({
    lineNumber: 1,
    itemId: '',
    locationId: '',
    uom: '',
    countedQuantity: '',
    unitCostForPositiveAdjustment: '',
    reasonCode: '',
    notes: '',
  }),
}))

import { useItemsList } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'
import { createInventoryCount } from '@features/inventory/api/counts'

const mockedUseItemsList = vi.mocked(useItemsList)
const mockedUseLocationsList = vi.mocked(useLocationsList)
const mockedCreateInventoryCount = vi.mocked(createInventoryCount)

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: '/inventory-counts/new',
        element: <InventoryCountCreatePage />,
      },
      {
        path: '/inventory-counts/:id',
        element: <div>__count_detail__</div>,
      },
    ],
    { initialEntries: ['/inventory-counts/new'] },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('InventoryCountCreatePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseItemsList.mockReturnValue({ data: { data: [] } } as any)
    mockedUseLocationsList.mockReturnValue({
      data: {
        data: [{ id: 'wh-1', code: 'WH', name: 'Warehouse', type: 'warehouse', warehouseId: 'wh-1', active: true }],
      },
    } as any)
    mockedCreateInventoryCount.mockResolvedValue({ id: 'count-1', warehouseId: 'wh-1', lines: [], summary: { lineCount: 0 } } as any)
  })

  it('navigates to detail after creating a count', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: '__create_count__' }))

    expect(await screen.findByText('__count_detail__')).toBeInTheDocument()
  })
})
