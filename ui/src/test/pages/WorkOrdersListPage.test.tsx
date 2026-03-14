import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import type { WorkOrder } from '@api/types'
import WorkOrdersListPage from '@features/workOrders/pages/WorkOrdersListPage'
import { renderWithQueryClient } from '../testUtils'

vi.mock('@features/items/queries', () => ({
  useItemsList: vi.fn(),
}))
vi.mock('@features/workOrders/queries', () => ({
  useWorkOrdersList: vi.fn(),
  workOrdersQueryKeys: {
    all: ['work-orders'],
  },
}))
vi.mock('@features/workOrders/api/workOrders', () => ({
  cancelWorkOrder: vi.fn(),
  markWorkOrderReady: vi.fn(),
}))
vi.mock('../../app/layout/usePageChrome', () => ({
  usePageChrome: () => ({ hideTitle: false }),
}))

import { useItemsList } from '@features/items/queries'
import { useWorkOrdersList } from '@features/workOrders/queries'
import { cancelWorkOrder, markWorkOrderReady } from '@features/workOrders/api/workOrders'

const mockedUseItemsList = vi.mocked(useItemsList)
const mockedUseWorkOrdersList = vi.mocked(useWorkOrdersList)
const mockedCancelWorkOrder = vi.mocked(cancelWorkOrder)
const mockedMarkWorkOrderReady = vi.mocked(markWorkOrderReady)

function makeWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    number: overrides.number ?? 'WO-1000',
    status: overrides.status ?? 'draft',
    kind: 'production',
    outputItemId: 'item-1',
    outputUom: 'kg',
    quantityPlanned: 10,
    quantityCompleted: 0,
    description: '',
    ...overrides,
  }
}

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: '/work-orders',
        element: <WorkOrdersListPage />,
      },
    ],
    { initialEntries: ['/work-orders'] },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('WorkOrdersListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseItemsList.mockReturnValue({ data: { data: [] } } as any)
    mockedUseWorkOrdersList.mockReturnValue({
      data: {
        data: [
          makeWorkOrder({ id: 'wo-draft', number: 'WO-DRAFT', status: 'draft' }),
          makeWorkOrder({ id: 'wo-ready', number: 'WO-READY', status: 'ready' }),
          makeWorkOrder({ id: 'wo-started', number: 'WO-STARTED', status: 'in_progress' }),
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
    } as any)
    mockedMarkWorkOrderReady.mockResolvedValue(makeWorkOrder({ id: 'wo-draft', number: 'WO-DRAFT', status: 'ready' }))
    mockedCancelWorkOrder.mockResolvedValue(makeWorkOrder({ id: 'wo-ready', number: 'WO-READY', status: 'canceled' }))
  })

  it('shows quick cancel for draft and ready rows and not for started rows', async () => {
    renderPage()

    expect(await screen.findByText('WO-DRAFT')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Mark ready' })).toBeInTheDocument()
  })

  it('opens a confirmation modal before canceling a ready work order', async () => {
    renderPage()

    fireEvent.click((await screen.findAllByRole('button', { name: 'Cancel' }))[1])
    expect(screen.getByText('Cancel WO-READY?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancel' }))
    await waitFor(() => {
      expect(mockedCancelWorkOrder).toHaveBeenCalledWith('wo-ready')
    })
  })
})
