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
vi.mock('@features/workOrders/components/IssueDraftForm', () => ({
  IssueDraftForm: () => <div>__issue_draft_form__</div>,
}))
vi.mock('@features/workOrders/components/CompletionDraftForm', () => ({
  CompletionDraftForm: () => <div>__completion_draft_form__</div>,
}))
vi.mock('@features/workOrders/components/RecordBatchForm', () => ({
  RecordBatchForm: () => <div>__record_batch_form__</div>,
}))
vi.mock('@features/workOrders/components/ReportProductionForm', () => ({
  ReportProductionForm: () => <div>__report_production_form__</div>,
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
  useWorkOrderExecution: vi.fn(),
  useWorkOrderRequirements: vi.fn(),
  workOrdersQueryKeys: {
    all: ['work-orders'],
    detail: (id: string) => ['work-orders', 'detail', id],
  },
}))
vi.mock('@features/workOrders/api/workOrders', () => ({
  createWorkOrder: vi.fn(),
  updateWorkOrderDescription: vi.fn(),
  useActiveBomVersion: vi.fn(),
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
import { useWorkOrder, useWorkOrderExecution, useWorkOrderRequirements } from '@features/workOrders/queries'
import { getAtp } from '@api/reports'

const mockedUseItem = vi.mocked(useItem)
const mockedUseItemsList = vi.mocked(useItemsList)
const mockedUseBom = vi.mocked(useBom)
const mockedUseBomsByItem = vi.mocked(useBomsByItem)
const mockedUseNextStepBoms = vi.mocked(useNextStepBoms)
const mockedUseLocationsList = vi.mocked(useLocationsList)
const mockedUseWorkOrder = vi.mocked(useWorkOrder)
const mockedUseWorkOrderExecution = vi.mocked(useWorkOrderExecution)
const mockedUseWorkOrderRequirements = vi.mocked(useWorkOrderRequirements)
const mockedGetAtp = vi.mocked(getAtp)

function makeWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'wo-1',
    number: 'WO-0001',
    status: 'released',
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
          status: 'released',
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
    expect(screen.getByText(/Remaining to complete:/i)).toBeInTheDocument()
  })

  it('renders report production panel on batch tab for production work orders', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ kind: 'production' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('__work_order_header__')
    fireEvent.click(screen.getByRole('button', { name: 'Report production' }))

    expect(screen.getByText('__report_production_form__')).toBeInTheDocument()
  })

  it('hides report production panel for disassembly work orders', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ kind: 'disassembly' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)
    mockedUseWorkOrderExecution.mockReturnValue({
      data: {
        workOrder: {
          id: 'wo-1',
          status: 'released',
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
    fireEvent.click(screen.getByRole('button', { name: 'Disassemble & record outputs' }))

    expect(screen.queryByText('__report_production_form__')).toBeNull()
    expect(screen.getByText('__record_batch_form__')).toBeInTheDocument()
  })

  it('switches tabs between issues and completions', async () => {
    mockedUseWorkOrder.mockReturnValue({
      data: makeWorkOrder({ kind: 'production' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any)

    renderPage()
    await screen.findByText('__work_order_header__')

    fireEvent.click(screen.getByRole('button', { name: 'Use materials' }))
    expect(screen.getByText('__issue_draft_form__')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Make product' }))
    expect(screen.getByText('__completion_draft_form__')).toBeInTheDocument()
  })
})
