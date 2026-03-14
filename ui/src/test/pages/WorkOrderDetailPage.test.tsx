import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import WorkOrderDetailPage from '@features/workOrders/pages/WorkOrderDetailPage'
import { renderWithQueryClient } from '../testUtils'
import type { WorkOrder } from '@api/types'

vi.mock('@features/workOrders/components/WorkOrderHeader', () => ({
  WorkOrderHeader: () => <div>__work_order_header__</div>,
}))
vi.mock('@features/workOrders/components/ExecutionSummaryPanel', () => ({
  ExecutionSummaryPanel: () => <div>__execution_summary__</div>,
}))
vi.mock('@features/workOrders/components/WorkOrderExecutionWorkspace', () => ({
  WorkOrderExecutionWorkspace: () => <div>__execution_workspace__</div>,
}))
vi.mock('@features/workOrders/components/WorkOrderRequirementsTable', () => ({
  WorkOrderRequirementsTable: () => <div>__requirements_table__</div>,
}))
vi.mock('@features/workOrders/components/WorkOrderNextStepPanel', () => ({
  WorkOrderNextStepPanel: () => <div>__next_step_panel__</div>,
}))

vi.mock('@features/items/queries', () => ({
  useItem: vi.fn(),
  useItemsList: vi.fn(),
}))
vi.mock('@features/boms/queries', () => ({
  useBom: vi.fn(),
  useBomsByItem: vi.fn(),
  useNextStepBoms: vi.fn(),
}))
vi.mock('@features/locations/queries', () => ({
  useLocationsList: vi.fn(),
}))
vi.mock('@features/workOrders/queries', () => ({
  useWorkOrder: vi.fn(),
  useWorkOrderDisassemblyPlan: vi.fn(),
  useWorkOrderExecution: vi.fn(),
  useWorkOrderReadiness: vi.fn(),
  useWorkOrderRequirements: vi.fn(),
  workOrdersQueryKeys: {
    all: ['work-orders'],
    detail: (id: string) => ['work-orders', 'detail', id],
  },
}))
vi.mock('@features/workOrders/api/workOrders', () => ({
  cancelWorkOrder: vi.fn(),
  closeWorkOrder: vi.fn(),
  createWorkOrder: vi.fn(),
  markWorkOrderReady: vi.fn(),
  updateWorkOrderDescription: vi.fn(),
  useActiveBomVersion: vi.fn(),
  voidWorkOrderProductionReport: vi.fn(),
}))
vi.mock('@api/reports', () => ({
  getAtp: vi.fn(),
}))
vi.mock('../../app/layout/usePageChrome', () => ({
  usePageChrome: () => ({ hideTitle: false, showBreadcrumbs: true, isShallow: false, sidebarVisible: true }),
}))

import { useItem, useItemsList } from '@features/items/queries'
import { useBom, useBomsByItem, useNextStepBoms } from '@features/boms/queries'
import { useLocationsList } from '@features/locations/queries'
import {
  useWorkOrder,
  useWorkOrderDisassemblyPlan,
  useWorkOrderExecution,
  useWorkOrderReadiness,
  useWorkOrderRequirements,
} from '@features/workOrders/queries'
import { getAtp } from '@api/reports'

const mockedUseItem = vi.mocked(useItem)
const mockedUseItemsList = vi.mocked(useItemsList)
const mockedUseBom = vi.mocked(useBom)
const mockedUseBomsByItem = vi.mocked(useBomsByItem)
const mockedUseNextStepBoms = vi.mocked(useNextStepBoms)
const mockedUseLocationsList = vi.mocked(useLocationsList)
const mockedUseWorkOrder = vi.mocked(useWorkOrder)
const mockedUseWorkOrderDisassemblyPlan = vi.mocked(useWorkOrderDisassemblyPlan)
const mockedUseWorkOrderExecution = vi.mocked(useWorkOrderExecution)
const mockedUseWorkOrderReadiness = vi.mocked(useWorkOrderReadiness)
const mockedUseWorkOrderRequirements = vi.mocked(useWorkOrderRequirements)
const mockedGetAtp = vi.mocked(getAtp)

function makeWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'wo-1',
    number: 'WO-0001',
    status: 'ready',
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
        path: '/work-orders/:id',
        element: <WorkOrderDetailPage />,
      },
    ],
    {
      initialEntries: ['/work-orders/wo-1'],
    },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('WorkOrderDetailPage tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseItem.mockReturnValue({ data: { id: 'item-1', defaultLocationId: null } } as any)
    mockedUseItemsList.mockReturnValue({ data: { data: [] } } as any)
    mockedUseBom.mockReturnValue({ data: undefined, refetch: vi.fn() } as any)
    mockedUseBomsByItem.mockReturnValue({ data: { boms: [] }, refetch: vi.fn() } as any)
    mockedUseNextStepBoms.mockReturnValue({
      data: { data: [] },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUseLocationsList.mockReturnValue({ data: { data: [] } } as any)
    mockedUseWorkOrderExecution.mockReturnValue({
      data: {
        workOrder: {
          id: 'wo-1',
          status: 'ready',
          kind: 'production',
          outputItemId: 'item-1',
          outputUom: 'kg',
          quantityPlanned: 10,
          quantityCompleted: 0,
          completedAt: null,
        },
        issuedTotals: [],
        completedTotals: [],
        remainingToComplete: 10,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as any)
    mockedUseWorkOrderReadiness.mockReturnValue({
      data: {
        workOrderId: 'wo-1',
        stageType: 'generic_production',
        stageLabel: 'Production',
        status: 'ready',
        consumeLocation: null,
        produceLocation: null,
        quantities: { planned: 10, produced: 0, scrapped: 0, remaining: 10 },
        hasShortage: false,
        reservations: [],
        lines: [],
      },
      isLoading: false,
      isError: false,
    } as any)
    mockedUseWorkOrderDisassemblyPlan.mockReturnValue({
      data: null,
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUseWorkOrderRequirements.mockReturnValue({
      data: { lines: [], bomVersionId: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as any)
    mockedGetAtp.mockResolvedValue({ data: [] } as any)
  })

  it('renders summary tab by default', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder(),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()
    expect(await screen.findByText('__work_order_header__')).toBeInTheDocument()
    expect(screen.getByText('__execution_summary__')).toBeInTheDocument()
  })

  it('renders unified execution workspace for production work orders', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ kind: 'production' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('__work_order_header__')

    expect(screen.getByText('__execution_workspace__')).toBeInTheDocument()
  })

  it('renders unified execution workspace for disassembly work orders', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ kind: 'disassembly' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
    mockedUseWorkOrderDisassemblyPlan.mockReturnValue({
      data: {
        workOrderId: 'wo-1',
        status: 'ready',
        bomId: 'bom-1',
        bomVersionId: 'bomv-1',
        consumeItemId: 'item-1',
        consumeLocation: null,
        quantities: { planned: 10, produced: 0, scrapped: 0, remaining: 10, requestedDisassembly: 10 },
        outputs: [],
      },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUseWorkOrderExecution.mockReturnValue({
      data: {
        workOrder: {
          id: 'wo-1',
          status: 'ready',
          kind: 'disassembly',
          outputItemId: 'item-1',
          outputUom: 'kg',
          quantityPlanned: 10,
          quantityCompleted: 0,
          completedAt: null,
        },
        issuedTotals: [],
        completedTotals: [],
        remainingToComplete: 10,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('__work_order_header__')

    expect(screen.getByText('__execution_workspace__')).toBeInTheDocument()
  })

  it('opens the execution workspace from the primary execution path', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ kind: 'production' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('__work_order_header__')

    fireEvent.click(screen.getByRole('button', { name: 'Review readiness' }))
    expect(screen.getByText('__execution_workspace__')).toBeInTheDocument()
  })

  it('relables description as operator notes', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ description: 'Shift handoff' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()

    expect(await screen.findByText('Operator notes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save operator notes' })).toBeInTheDocument()
  })

  it('locks execution for completed work orders', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'completed', quantityCompleted: 10 }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
    mockedUseWorkOrderExecution.mockReturnValue({
      data: {
        workOrder: {
          id: 'wo-1',
          status: 'completed',
          kind: 'production',
          outputItemId: 'item-1',
          outputUom: 'kg',
          quantityPlanned: 10,
          quantityCompleted: 10,
          completedAt: '2026-03-14T00:00:00.000Z',
        },
        issuedTotals: [],
        completedTotals: [],
        remainingToComplete: 0,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as any)

    renderPage()

    expect(await screen.findByText('Execution locked')).toBeInTheDocument()
    expect(screen.queryByText('__execution_workspace__')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close work order' })).toBeInTheDocument()
  })
})
