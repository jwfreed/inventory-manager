import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { ReportProductionForm } from '@features/workOrders/components/ReportProductionForm'
import { renderWithQueryClient } from '../testUtils'
import type { WorkOrder } from '@api/types'

vi.mock('@features/workOrders/api/workOrders', () => ({
  reportWorkOrderProduction: vi.fn(),
}))

vi.mock('uuid', () => ({
  v4: vi.fn(),
}))

import { reportWorkOrderProduction } from '@features/workOrders/api/workOrders'
import { v4 as uuidv4 } from 'uuid'

const mockedReportWorkOrderProduction = vi.mocked(reportWorkOrderProduction)
const mockedUuidv4 = vi.mocked(uuidv4)

function makeWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'wo-1',
    number: 'WO-0001',
    status: 'released',
    kind: 'production',
    outputItemId: 'item-1',
    outputUom: 'kg',
    quantityPlanned: 10,
    quantityCompleted: 2,
    ...overrides,
  }
}

describe('ReportProductionForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUuidv4
      .mockReturnValueOnce('uuid-1')
      .mockReturnValueOnce('uuid-2')
      .mockReturnValueOnce('uuid-3')
  })

  it('blocks submit for zero quantity', async () => {
    const onRefetch = vi.fn()
    mockedReportWorkOrderProduction.mockResolvedValue({
      workOrderId: 'wo-1',
      productionReportId: 'pr-1',
      componentIssueMovementId: 'im-1',
      productionReceiptMovementId: 'rm-1',
      idempotencyKey: 'idemp-1',
      replayed: false,
    })

    renderWithQueryClient(
      <ReportProductionForm workOrder={makeWorkOrder({ quantityPlanned: 0, quantityCompleted: 0 })} onRefetch={onRefetch} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Report Production' }))

    expect(await screen.findByText('Produced quantity must be greater than zero.')).toBeInTheDocument()
    expect(mockedReportWorkOrderProduction).not.toHaveBeenCalled()
  })

  it('shows pending state while mutation is in-flight', async () => {
    let resolveRequest: ((value: any) => void) | null = null
    mockedReportWorkOrderProduction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve
        }),
    )

    renderWithQueryClient(<ReportProductionForm workOrder={makeWorkOrder()} onRefetch={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Report Production' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Posting...' })).toBeDisabled()
    })

    resolveRequest?.({
      workOrderId: 'wo-1',
      productionReportId: 'pr-1',
      componentIssueMovementId: 'im-1',
      productionReceiptMovementId: 'rm-1',
      idempotencyKey: 'idemp-1',
      replayed: false,
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Report Production' })).toBeInTheDocument()
    })
  })

  it('renders success alert on successful submission', async () => {
    const onRefetch = vi.fn()
    mockedReportWorkOrderProduction.mockResolvedValue({
      workOrderId: 'wo-1',
      productionReportId: 'pr-1',
      componentIssueMovementId: 'im-1',
      productionReceiptMovementId: 'rm-1',
      idempotencyKey: 'idemp-1',
      replayed: false,
    })

    renderWithQueryClient(<ReportProductionForm workOrder={makeWorkOrder()} onRefetch={onRefetch} />)
    fireEvent.click(screen.getByRole('button', { name: 'Report Production' }))

    expect(await screen.findByText('Production reported')).toBeInTheDocument()
    expect(screen.getByText(/Posted issue movement im-1 and receipt movement rm-1/i)).toBeInTheDocument()
    expect(onRefetch).toHaveBeenCalledWith({ showSummaryToast: true })
  })

  it('renders error alert on failed submission', async () => {
    mockedReportWorkOrderProduction.mockRejectedValue({ message: 'Upstream failed' })

    renderWithQueryClient(<ReportProductionForm workOrder={makeWorkOrder()} onRefetch={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Report Production' }))

    expect(await screen.findByText('Report failed')).toBeInTheDocument()
    expect(screen.getByText('Upstream failed')).toBeInTheDocument()
  })

  it('renders receive-to source labels', () => {
    const { rerender } = renderWithQueryClient(
      <ReportProductionForm
        workOrder={makeWorkOrder({
          reportProductionReceiveToLocationName: 'Finished Goods',
          reportProductionReceiveToLocationCode: 'FG',
          reportProductionReceiveToSource: 'routing_snapshot',
        })}
        onRefetch={vi.fn()}
      />,
    )

    expect(screen.getByText(/Routing snapshot/)).toBeInTheDocument()

    rerender(
      <ReportProductionForm
        workOrder={makeWorkOrder({
          reportProductionReceiveToLocationName: 'Packaging',
          reportProductionReceiveToLocationCode: 'PACK',
          reportProductionReceiveToSource: 'work_order_default',
        })}
        onRefetch={vi.fn()}
      />,
    )
    expect(screen.getByText(/Work order default/)).toBeInTheDocument()

    rerender(
      <ReportProductionForm
        workOrder={makeWorkOrder({
          reportProductionReceiveToLocationName: null,
          reportProductionReceiveToLocationCode: null,
          reportProductionReceiveToSource: null,
        })}
        onRefetch={vi.fn()}
      />,
    )
    expect(screen.getByText('Receive-to location: System default')).toBeInTheDocument()
  })

  it('reuses clientRequestId for retry without form edits', async () => {
    mockedReportWorkOrderProduction
      .mockRejectedValueOnce({ message: 'temporary failure' })
      .mockResolvedValueOnce({
        workOrderId: 'wo-1',
        productionReportId: 'pr-1',
        componentIssueMovementId: 'im-1',
        productionReceiptMovementId: 'rm-1',
        idempotencyKey: 'idemp-1',
        replayed: true,
      })

    renderWithQueryClient(<ReportProductionForm workOrder={makeWorkOrder()} onRefetch={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Report Production' }))
    await screen.findByText('Report failed')

    fireEvent.click(screen.getByRole('button', { name: 'Report Production' }))

    await waitFor(() => {
      expect(mockedReportWorkOrderProduction).toHaveBeenCalledTimes(2)
    })
    const firstRequestId = mockedReportWorkOrderProduction.mock.calls[0][1].clientRequestId
    const secondRequestId = mockedReportWorkOrderProduction.mock.calls[1][1].clientRequestId
    expect(firstRequestId).toBeTruthy()
    expect(secondRequestId).toBe(firstRequestId)
  })

  it('resets clientRequestId when form values are edited', async () => {
    mockedReportWorkOrderProduction
      .mockRejectedValueOnce({ message: 'temporary failure' })
      .mockResolvedValueOnce({
        workOrderId: 'wo-1',
        productionReportId: 'pr-1',
        componentIssueMovementId: 'im-1',
        productionReceiptMovementId: 'rm-1',
        idempotencyKey: 'idemp-1',
        replayed: false,
      })

    renderWithQueryClient(<ReportProductionForm workOrder={makeWorkOrder()} onRefetch={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Report Production' }))
    await screen.findByText('Report failed')

    const noteInput = screen.getByPlaceholderText('Reference, operator note, or batch context')
    fireEvent.change(noteInput, { target: { value: 'retry with note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Report Production' }))

    await waitFor(() => {
      expect(mockedReportWorkOrderProduction).toHaveBeenCalledTimes(2)
    })
    const firstRequestId = mockedReportWorkOrderProduction.mock.calls[0][1].clientRequestId
    const secondRequestId = mockedReportWorkOrderProduction.mock.calls[1][1].clientRequestId
    expect(firstRequestId).toBeTruthy()
    expect(secondRequestId).toBeTruthy()
    expect(secondRequestId).not.toBe(firstRequestId)
  })
})
