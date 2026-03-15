import { describe, expect, it, beforeEach, vi } from 'vitest'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { screen } from '@testing-library/react'
import { renderWithQueryClient } from '../testUtils'
import InventoryOperationsDashboardPage from '@features/inventory/pages/InventoryOperationsDashboardPage'

vi.mock('@features/locations/queries', () => ({
  useLocationsList: vi.fn(),
}))
vi.mock('@features/inventory/queries', () => ({
  useInventoryCountsList: vi.fn(),
}))
vi.mock('@features/adjustments/queries', () => ({
  useInventoryAdjustmentsList: vi.fn(),
}))
vi.mock('@features/ledger/queries', () => ({
  useMovementsList: vi.fn(),
}))

import { useLocationsList } from '@features/locations/queries'
import { useInventoryCountsList } from '@features/inventory/queries'
import { useInventoryAdjustmentsList } from '@features/adjustments/queries'
import { useMovementsList } from '@features/ledger/queries'

const mockedUseLocationsList = vi.mocked(useLocationsList)
const mockedUseInventoryCountsList = vi.mocked(useInventoryCountsList)
const mockedUseInventoryAdjustmentsList = vi.mocked(useInventoryAdjustmentsList)
const mockedUseMovementsList = vi.mocked(useMovementsList)

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: '/inventory/operations',
        element: <InventoryOperationsDashboardPage />,
      },
    ],
    { initialEntries: ['/inventory/operations'] },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('InventoryOperationsDashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseLocationsList.mockReturnValue({
      data: {
        data: [
          {
            id: 'wh-1',
            code: 'WH-1',
            name: 'Main Warehouse',
            type: 'warehouse',
          },
        ],
      },
    } as any)
    mockedUseInventoryCountsList.mockReturnValue({
      data: {
        data: [
          {
            id: 'count-1',
            status: 'draft',
            countedAt: '2026-03-14T10:00:00.000Z',
            updatedAt: '2026-03-14T11:00:00.000Z',
            summary: {
              lineCount: 3,
              linesWithVariance: 1,
            },
          },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUseInventoryAdjustmentsList.mockReturnValue({
      data: {
        data: [
          {
            id: 'adj-1',
            status: 'posted',
            occurredAt: '2026-03-14T08:00:00.000Z',
            updatedAt: '2026-03-14T08:05:00.000Z',
            notes: 'Cycle-count correction',
          },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUseMovementsList
      .mockReturnValueOnce({
        data: {
          data: [
            {
              id: 'move-transfer-1',
              status: 'posted',
              occurredAt: '2026-03-14T09:00:00.000Z',
              postedAt: '2026-03-14T09:01:00.000Z',
              externalRef: 'transfer:tr-1',
              notes: 'Bin rebalance',
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
              occurredAt: '2026-03-14T12:00:00.000Z',
              postedAt: '2026-03-14T12:01:00.000Z',
              externalRef: 'work_order_batch_completion:exec-1:wo-1',
              notes: 'Output received',
            },
          ],
        },
        isLoading: false,
        isError: false,
        error: null,
      } as any)
  })

  it('renders latest operational activity panels from existing queries', async () => {
    renderPage()

    expect(await screen.findByText('Inventory Operations')).toBeInTheDocument()
    expect(screen.getAllByText('Recent counts')).toHaveLength(2)
    expect(screen.getAllByText('Recent adjustments')).toHaveLength(2)
    expect(screen.getAllByText('Recent transfers')).toHaveLength(2)
    expect(screen.getByRole('heading', { name: 'Recent production activity' })).toBeInTheDocument()
    expect(screen.getByText('Count count-1')).toBeInTheDocument()
    expect(screen.getByText('Adjustment adj-1')).toBeInTheDocument()
    expect(screen.getByText('Transfer movement move-tra')).toBeInTheDocument()
    expect(screen.getByText('Production report exec-1 posted')).toBeInTheDocument()
  })
})
