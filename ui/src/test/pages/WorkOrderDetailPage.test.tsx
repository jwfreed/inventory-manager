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
vi.mock('@features/ledger/queries', () => ({
  useMovementsList: vi.fn(),
  ledgerQueryKeys: {
    all: ['movements'],
    list: (params: unknown) => ['movements', 'list', params],
  },
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
    execution: (id: string) => ['work-orders', 'execution', id],
    readiness: (id: string) => ['work-orders', 'readiness', id],
    requirements: (id: string) => ['work-orders', 'requirements', id],
    disassemblyPlan: (id: string) => ['work-orders', 'disassembly-plan', id],
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
import { useMovementsList } from '@features/ledger/queries'
import {
  useWorkOrder,
  useWorkOrderDisassemblyPlan,
  useWorkOrderExecution,
  useWorkOrderReadiness,
  useWorkOrderRequirements,
} from '@features/workOrders/queries'
import { getAtp } from '@api/reports'
import {
  cancelWorkOrder as cancelWorkOrderMutation,
  closeWorkOrder as closeWorkOrderMutation,
  markWorkOrderReady as markWorkOrderReadyMutation,
} from '@features/workOrders/api/workOrders'

const mockedUseItem = vi.mocked(useItem)
const mockedUseItemsList = vi.mocked(useItemsList)
const mockedUseBom = vi.mocked(useBom)
const mockedUseBomsByItem = vi.mocked(useBomsByItem)
const mockedUseNextStepBoms = vi.mocked(useNextStepBoms)
const mockedUseLocationsList = vi.mocked(useLocationsList)
const mockedUseMovementsList = vi.mocked(useMovementsList)
const mockedUseWorkOrder = vi.mocked(useWorkOrder)
const mockedUseWorkOrderDisassemblyPlan = vi.mocked(useWorkOrderDisassemblyPlan)
const mockedUseWorkOrderExecution = vi.mocked(useWorkOrderExecution)
const mockedUseWorkOrderReadiness = vi.mocked(useWorkOrderReadiness)
const mockedUseWorkOrderRequirements = vi.mocked(useWorkOrderRequirements)
const mockedGetAtp = vi.mocked(getAtp)
const mockedCancelWorkOrder = vi.mocked(cancelWorkOrderMutation)
const mockedCloseWorkOrder = vi.mocked(closeWorkOrderMutation)
const mockedMarkWorkOrderReady = vi.mocked(markWorkOrderReadyMutation)

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
    mockedUseMovementsList.mockReturnValue({
      data: {
        data: [
          {
            id: 'movement-1',
            status: 'posted',
            occurredAt: '2026-03-14T10:00:00.000Z',
            postedAt: '2026-03-14T10:01:00.000Z',
            externalRef: 'work_order_batch_completion:exec-1:wo-1',
            notes: 'Batch completion posted',
          },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
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
    mockedMarkWorkOrderReady.mockResolvedValue(makeWorkOrder({ status: 'ready' }))
    mockedCancelWorkOrder.mockResolvedValue(makeWorkOrder({ status: 'canceled' }))
    mockedCloseWorkOrder.mockResolvedValue(makeWorkOrder({ status: 'closed', quantityCompleted: 10 }))
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

  it('renders an operational history panel from ledger movements', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'ready' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()

    expect(await screen.findByText('Operational History')).toBeInTheDocument()
    expect(screen.getByText('Production report exec-1 posted')).toBeInTheDocument()
    expect(mockedUseMovementsList).toHaveBeenCalledWith(
      { externalRef: 'wo-1', limit: 100 },
      expect.objectContaining({ enabled: true, staleTime: 30_000 }),
    )
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
    expect(screen.getByText('Operational History')).toBeInTheDocument()
    expect(screen.queryByText('__execution_workspace__')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close Work Order' })).toBeInTheDocument()
  })

  it('opens the detail cancel confirmation and invalidates all work-order branches on confirm', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'ready' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    const { queryClient } = renderPage()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Work Order' }))
    expect(screen.getByText('Cancel Work Order WO-0001?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Cancel Work Order' }))

    await screen.findByText('Lifecycle updated')
    expect(mockedCancelWorkOrder).toHaveBeenCalledWith('wo-1')
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['work-orders'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['work-orders', 'detail', 'wo-1'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['work-orders', 'execution', 'wo-1'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['work-orders', 'readiness', 'wo-1'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['work-orders', 'requirements', 'wo-1'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['work-orders', 'disassembly-plan', 'wo-1'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['movements'] })
  })
})
