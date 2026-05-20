import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import WorkOrderDetailPage from '@features/workOrders/pages/WorkOrderDetailPage'
import { renderWithQueryClient } from '../testUtils'
import type { WorkOrder } from '@api/types'

let authPermissions: string[] = ['production:write']

vi.mock('@shared/auth', () => ({
  useAuth: () => ({
    hasPermission: (permission: string) => authPermissions.includes(permission),
  }),
}))

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
  WorkOrderNextStepPanel: ({ onCancel }: { onCancel: () => void }) => (
    <div>
      __next_step_panel__
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  ),
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
    authPermissions = ['production:write']
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

  it('hides Close Work Order button when production:write permission is absent', async () => {
    authPermissions = []
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'completed', quantityCompleted: 10 }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('__work_order_header__')

    expect(screen.queryByRole('button', { name: 'Close Work Order' })).not.toBeInTheDocument()
  })

  it('opens Close Work Order modal for authorized user and submits', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'completed', quantityCompleted: 10 }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Close Work Order' }))
    expect(screen.getByText('Close Work Order?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Close Work Order' }))

    await screen.findByText('Lifecycle updated')
    expect(mockedCloseWorkOrder).toHaveBeenCalledWith('wo-1')
  })

  it('hides Cancel Work Order button when production:write permission is absent', async () => {
    authPermissions = []
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'ready' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('__work_order_header__')

    expect(screen.queryByRole('button', { name: 'Cancel Work Order' })).not.toBeInTheDocument()
  })

  it('does not open cancel modal when production:write permission is absent', async () => {
    authPermissions = []
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'ready' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('__work_order_header__')

    expect(screen.queryByText('Cancel Work Order WO-0001?')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel Work Order' })).not.toBeInTheDocument()
  })

  it('hides Ready Work Order button when production:write permission is absent', async () => {
    authPermissions = []
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'draft' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('__work_order_header__')

    expect(screen.queryByRole('button', { name: 'Ready Work Order' })).not.toBeInTheDocument()
  })

  it('shows Cancel Work Order button and opens modal for authorized user', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'ready' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Work Order' }))
    expect(screen.getByText('Cancel Work Order WO-0001?')).toBeInTheDocument()
  })

  it('shows Ready Work Order button for authorized user', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'draft' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('__work_order_header__')

    expect(screen.getByRole('button', { name: 'Ready Work Order' })).toBeInTheDocument()
  })

  it('shows contextual CTA when a single next-step BOM is available', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'ready', quantityCompleted: 10 }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
    mockedUseItemsList.mockReturnValue({
      data: { data: [{ id: 'item-2', name: 'Milk Chocolate Bar 75g', sku: 'MCB-75' }] },
    } as any)
    mockedUseNextStepBoms.mockReturnValue({
      data: { data: [{ id: 'bom-2', bomCode: 'BOM-BAR', outputItemId: 'item-2', defaultUom: 'units' }] },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUseWorkOrderExecution.mockReturnValue({
      data: {
        workOrder: {
          id: 'wo-1', status: 'ready', kind: 'production',
          outputItemId: 'item-1', outputUom: 'kg',
          quantityPlanned: 10, quantityCompleted: 10, completedAt: null,
        },
        issuedTotals: [{ itemId: 'item-1', quantityIssued: 10 }],
        completedTotals: [],
        remainingToComplete: 0,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('__work_order_header__')

    expect(screen.getByRole('button', { name: 'Create WO: Milk Chocolate Bar 75g' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create next step WO' })).not.toBeInTheDocument()
  })

  it('shows "Choose next work order" CTA when multiple next-step BOMs are available', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'ready', quantityCompleted: 10 }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
    mockedUseItemsList.mockReturnValue({
      data: {
        data: [
          { id: 'item-2', name: 'Bar A', sku: 'BAR-A' },
          { id: 'item-3', name: 'Bar B', sku: 'BAR-B' },
        ],
      },
    } as any)
    mockedUseNextStepBoms.mockReturnValue({
      data: {
        data: [
          { id: 'bom-2', bomCode: 'BOM-A', outputItemId: 'item-2', defaultUom: 'units' },
          { id: 'bom-3', bomCode: 'BOM-B', outputItemId: 'item-3', defaultUom: 'units' },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUseWorkOrderExecution.mockReturnValue({
      data: {
        workOrder: {
          id: 'wo-1', status: 'ready', kind: 'production',
          outputItemId: 'item-1', outputUom: 'kg',
          quantityPlanned: 10, quantityCompleted: 10, completedAt: null,
        },
        issuedTotals: [{ itemId: 'item-1', quantityIssued: 10 }],
        completedTotals: [],
        remainingToComplete: 0,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('__work_order_header__')

    expect(screen.getByRole('button', { name: 'Choose next work order' })).toBeInTheDocument()
  })

  it('hides Primary execution path panel for completed work orders', async () => {
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
          id: 'wo-1', status: 'completed', kind: 'production',
          outputItemId: 'item-1', outputUom: 'kg',
          quantityPlanned: 10, quantityCompleted: 10, completedAt: '2026-03-14T00:00:00.000Z',
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
    await screen.findByText('Execution locked')

    expect(screen.queryByText('Primary execution path')).not.toBeInTheDocument()
  })

  it('shows workflow status section in context rail with status label', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'ready' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('__work_order_header__')

    expect(screen.getByText('Workflow status')).toBeInTheDocument()
    expect(screen.getAllByText('ready').length).toBeGreaterThan(0)
  })

  it('shows context rail workflow section with View movements for completed work orders', async () => {
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
          id: 'wo-1', status: 'completed', kind: 'production',
          outputItemId: 'item-1', outputUom: 'kg',
          quantityPlanned: 10, quantityCompleted: 10, completedAt: '2026-03-14T00:00:00.000Z',
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
    await screen.findByText('Execution locked')

    // The workflow status section in context rail should show produced/remaining
    expect(screen.getByText('Produced')).toBeInTheDocument()
    expect(screen.getAllByText('Remaining').length).toBeGreaterThan(0)
  })

  it('does not render Configuration health section when work order has no BOM', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'draft', bomId: undefined }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('__work_order_header__')

    expect(screen.queryByText('Configuration health')).not.toBeInTheDocument()
  })

  it('shows downstream CTA in context rail for completed WO with one downstream BOM', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'completed', quantityCompleted: 10 }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
    mockedUseItemsList.mockReturnValue({
      data: { data: [{ id: 'item-2', name: 'Milk Chocolate Bar 75g', sku: 'MCB-75' }] },
    } as any)
    mockedUseNextStepBoms.mockReturnValue({
      data: { data: [{ id: 'bom-2', bomCode: 'BOM-BAR', outputItemId: 'item-2', defaultUom: 'units' }] },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUseWorkOrderExecution.mockReturnValue({
      data: {
        workOrder: {
          id: 'wo-1', status: 'completed', kind: 'production',
          outputItemId: 'item-1', outputUom: 'kg',
          quantityPlanned: 10, quantityCompleted: 10, completedAt: '2026-03-14T00:00:00.000Z',
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
    await screen.findByText('Execution locked')

    // Context rail and mobile sticky bar both show the contextual downstream CTA
    const ctaButtons = screen.getAllByRole('button', { name: 'Create WO: Milk Chocolate Bar 75g' })
    expect(ctaButtons.length).toBeGreaterThan(0)
    // View movements is also present as secondary action
    expect(screen.getAllByRole('button', { name: 'View movements' }).length).toBeGreaterThan(0)
    // Panel is closed initially — not rendered until CTA is clicked
    expect(screen.queryByText('__next_step_panel__')).not.toBeInTheDocument()
    // Clicking the CTA opens the panel
    fireEvent.click(ctaButtons[0])
    const panel = screen.getByText('__next_step_panel__').parentElement!
    expect(panel).toBeInTheDocument()
    // Clicking Cancel closes the panel
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('__next_step_panel__')).not.toBeInTheDocument()
  })

  it('shows "Choose next work order" in context rail for completed WO with multiple downstream BOMs', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'completed', quantityCompleted: 10 }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
    mockedUseItemsList.mockReturnValue({
      data: {
        data: [
          { id: 'item-2', name: 'Bar A', sku: 'BAR-A' },
          { id: 'item-3', name: 'Bar B', sku: 'BAR-B' },
        ],
      },
    } as any)
    mockedUseNextStepBoms.mockReturnValue({
      data: {
        data: [
          { id: 'bom-2', bomCode: 'BOM-A', outputItemId: 'item-2', defaultUom: 'units' },
          { id: 'bom-3', bomCode: 'BOM-B', outputItemId: 'item-3', defaultUom: 'units' },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUseWorkOrderExecution.mockReturnValue({
      data: {
        workOrder: {
          id: 'wo-1', status: 'completed', kind: 'production',
          outputItemId: 'item-1', outputUom: 'kg',
          quantityPlanned: 10, quantityCompleted: 10, completedAt: '2026-03-14T00:00:00.000Z',
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
    await screen.findByText('Execution locked')

    const ctaButtons = screen.getAllByRole('button', { name: 'Choose next work order' })
    expect(ctaButtons.length).toBeGreaterThan(0)
    // Panel is closed initially — not rendered until CTA is clicked
    expect(screen.queryByText('__next_step_panel__')).not.toBeInTheDocument()
    // Clicking the CTA opens the panel
    fireEvent.click(ctaButtons[0])
    const panel = screen.getByText('__next_step_panel__').parentElement!
    expect(panel).toBeInTheDocument()
    // Clicking Cancel closes the panel
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('__next_step_panel__')).not.toBeInTheDocument()
  })

  it('shows View movements and no downstream CTA for completed WO with no downstream BOM', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'completed', quantityCompleted: 10 }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
    mockedUseNextStepBoms.mockReturnValue({
      data: { data: [] },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUseWorkOrderExecution.mockReturnValue({
      data: {
        workOrder: {
          id: 'wo-1', status: 'completed', kind: 'production',
          outputItemId: 'item-1', outputUom: 'kg',
          quantityPlanned: 10, quantityCompleted: 10, completedAt: '2026-03-14T00:00:00.000Z',
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
    await screen.findByText('Execution locked')

    expect(screen.getAllByRole('button', { name: 'View movements' }).length).toBeGreaterThan(0)
    // No downstream panel for locked WO without BOMs
    expect(screen.queryByText('__next_step_panel__')).not.toBeInTheDocument()
    // No Create WO button variants
    expect(screen.queryByRole('button', { name: /^Create WO:/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Choose next work order' })).not.toBeInTheDocument()
  })

  it('does not render "Create next-step WO" anywhere for an active WO with a single downstream BOM', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'ready', quantityCompleted: 10 }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
    mockedUseItemsList.mockReturnValue({
      data: { data: [{ id: 'item-2', name: 'Milk Chocolate Bar 75g', sku: 'MCB-75' }] },
    } as any)
    mockedUseNextStepBoms.mockReturnValue({
      data: { data: [{ id: 'bom-2', bomCode: 'BOM-BAR', outputItemId: 'item-2', defaultUom: 'units' }] },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    mockedUseWorkOrderExecution.mockReturnValue({
      data: {
        workOrder: {
          id: 'wo-1', status: 'ready', kind: 'production',
          outputItemId: 'item-1', outputUom: 'kg',
          quantityPlanned: 10, quantityCompleted: 10, completedAt: null,
        },
        issuedTotals: [{ componentItemId: 'item-c', componentItemName: 'Cacao', componentItemSku: 'CAC', uom: 'kg', quantityIssued: 5 }],
        completedTotals: [],
        remainingToComplete: 0,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('__work_order_header__')

    expect(screen.queryByText('Create next-step WO')).not.toBeInTheDocument()
    expect(screen.queryByText('Create next step WO')).not.toBeInTheDocument()
  })

  it('does not show "Post production from this page" for completed work orders', async () => {
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
          id: 'wo-1', status: 'completed', kind: 'production',
          outputItemId: 'item-1', outputUom: 'kg',
          quantityPlanned: 10, quantityCompleted: 10, completedAt: '2026-03-14T00:00:00.000Z',
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
    await screen.findByText('Execution locked')

    expect(screen.queryByText(/Post production from this page/)).not.toBeInTheDocument()
  })

  it('shows inventory impact summary for completed work orders with execution data', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'completed', quantityCompleted: 1 }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
    mockedUseWorkOrderExecution.mockReturnValue({
      data: {
        workOrder: {
          id: 'wo-1', status: 'completed', kind: 'production',
          outputItemId: 'item-1', outputUom: 'kg',
          quantityPlanned: 1, quantityCompleted: 1, completedAt: '2026-03-14T00:00:00.000Z',
        },
        issuedTotals: [
          { componentItemId: 'item-c1', componentItemName: 'Cacao nibs', componentItemSku: 'CN-001', uom: 'g', quantityIssued: 400 },
          { componentItemId: 'item-c2', componentItemName: 'Milk powder', componentItemSku: 'MP-001', uom: 'g', quantityIssued: 200 },
        ],
        completedTotals: [
          { outputItemId: 'item-1', outputItemName: 'Milk Chocolate Base', outputItemSku: 'MCB-001', uom: 'kg', quantityCompleted: 1 },
        ],
        remainingToComplete: 0,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('Execution locked')

    expect(screen.getByText('Inventory impact')).toBeInTheDocument()
    expect(screen.getByText('Milk Chocolate Base')).toBeInTheDocument()
    expect(screen.getByText('Cacao nibs')).toBeInTheDocument()
    expect(screen.getByText('Milk powder')).toBeInTheDocument()
  })

  it('completed WO does not render editable WorkOrderExecutionWorkspace', async () => {
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
          id: 'wo-1', status: 'completed', kind: 'production',
          outputItemId: 'item-1', outputUom: 'kg',
          quantityPlanned: 10, quantityCompleted: 10, completedAt: '2026-03-14T00:00:00.000Z',
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
    await screen.findByText('Execution locked')

    expect(screen.queryByText('__execution_workspace__')).not.toBeInTheDocument()
  })

  it('hides Recent production report section when work order execution is locked', async () => {
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
          id: 'wo-1', status: 'completed', kind: 'production',
          outputItemId: 'item-1', outputUom: 'kg',
          quantityPlanned: 10, quantityCompleted: 10, completedAt: '2026-03-14T00:00:00.000Z',
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
    await screen.findByText('Execution locked')

    expect(screen.queryByText('Recent production report')).not.toBeInTheDocument()
    expect(screen.queryByText(/Only the most recent report/)).not.toBeInTheDocument()
  })

  it('shows BOM code (not raw UUID) in Configuration health context rail', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ status: 'ready', bomId: 'bom-uuid-123' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
    mockedUseBom.mockReturnValue({
      data: { id: 'bom-uuid-123', bomCode: 'BOM-CHOC-BASE', versions: [] },
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('__work_order_header__')

    expect(screen.getByText('Configuration health')).toBeInTheDocument()
    expect(screen.getByText('BOM-CHOC-BASE')).toBeInTheDocument()
    expect(screen.queryByText('bom-uuid-123')).not.toBeInTheDocument()
  })

  it('shows Work order status panel title (not Execution workspace) when execution is locked', async () => {
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
          id: 'wo-1', status: 'completed', kind: 'production',
          outputItemId: 'item-1', outputUom: 'kg',
          quantityPlanned: 10, quantityCompleted: 10, completedAt: '2026-03-14T00:00:00.000Z',
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
    await screen.findByText('Execution locked')

    expect(screen.getByText('Work order status')).toBeInTheDocument()
    expect(screen.queryByText('Execution workspace')).not.toBeInTheDocument()
  })
})
