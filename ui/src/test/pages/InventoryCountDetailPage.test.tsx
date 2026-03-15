import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '../testUtils'
import InventoryCountDetailPage from '@features/inventory/pages/InventoryCountDetailPage'

vi.mock('@features/items/queries', () => ({
  useItemsList: vi.fn(),
}))
vi.mock('@features/locations/queries', () => ({
  useLocationsList: vi.fn(),
}))
vi.mock('@features/inventory/queries', () => ({
  useInventoryCount: vi.fn(),
  inventoryQueryKeys: {
    all: ['inventory'],
    countsListRoot: ['inventory', 'counts-list'],
    countsDetail: (id: string) => ['inventory', 'counts-detail', id],
    countsList: () => ['inventory', 'counts-list'],
  },
}))
vi.mock('@features/inventory/api/counts', () => ({
  postInventoryCount: vi.fn(),
  updateInventoryCount: vi.fn(),
}))
vi.mock('@features/inventory/components/InventoryCountForm', () => ({
  InventoryCountForm: ({ submitLabel, onSubmit }: { submitLabel: string; onSubmit: () => void }) => (
    <button type="button" onClick={onSubmit}>
      {submitLabel}
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
import { useInventoryCount } from '@features/inventory/queries'
import { postInventoryCount, updateInventoryCount } from '@features/inventory/api/counts'

const mockedUseItemsList = vi.mocked(useItemsList)
const mockedUseLocationsList = vi.mocked(useLocationsList)
const mockedUseInventoryCount = vi.mocked(useInventoryCount)
const mockedPostInventoryCount = vi.mocked(postInventoryCount)
const mockedUpdateInventoryCount = vi.mocked(updateInventoryCount)

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: '/inventory-counts/:id',
        element: <InventoryCountDetailPage />,
      },
    ],
    { initialEntries: ['/inventory-counts/count-1'] },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('InventoryCountDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseItemsList.mockReturnValue({ data: { data: [] } } as any)
    mockedUseLocationsList.mockReturnValue({ data: { data: [] } } as any)
    mockedUseInventoryCount.mockReturnValue({
      data: {
        id: 'count-1',
        warehouseId: 'wh-1',
        status: 'draft',
        countedAt: '2026-03-14T00:00:00.000Z',
        notes: '',
        lines: [],
        summary: {
          lineCount: 1,
          totalAbsVariance: 0,
          hits: 1,
          hitRate: 1,
          linesWithVariance: 0,
          totalSystemQty: 0,
          weightedVariancePct: 0,
          weightedAccuracyPct: 1,
        },
      },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUpdateInventoryCount.mockResolvedValue({ id: 'count-1', warehouseId: 'wh-1', lines: [], summary: { lineCount: 1 } } as any)
    mockedPostInventoryCount.mockResolvedValue({ id: 'count-1', warehouseId: 'wh-1', lines: [], summary: { lineCount: 1 } } as any)
  })

  it('opens a confirmation modal before posting a count', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Post count' }))
    expect(screen.getByText('Post inventory count?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm post' }))
    await waitFor(() => {
      expect(mockedPostInventoryCount).toHaveBeenCalledWith('count-1', { warehouseId: 'wh-1' })
    })
  })

  it('shows count status metadata and read-only guard for posted counts', async () => {
    mockedUseInventoryCount.mockReturnValue({
      data: {
        id: 'count-1',
        warehouseId: 'wh-1',
        status: 'posted',
        countedAt: '2026-03-14T00:00:00.000Z',
        updatedAt: '2026-03-14T01:00:00.000Z',
        postedAt: '2026-03-14T02:00:00.000Z',
        inventoryMovementId: 'movement-1',
        notes: '',
        lines: [],
        summary: {
          lineCount: 1,
          totalAbsVariance: 0,
          hits: 1,
          hitRate: 1,
          linesWithVariance: 0,
          totalSystemQty: 0,
          weightedVariancePct: 0,
          weightedAccuracyPct: 1,
        },
      },
      isLoading: false,
      isError: false,
      error: null,
    } as any)

    renderPage()

    expect(await screen.findByText('Last updated')).toBeInTheDocument()
    expect(screen.getByText('Posted at')).toBeInTheDocument()
    expect(screen.getByText('Count locked')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View movement' })).toBeInTheDocument()
  })
})
