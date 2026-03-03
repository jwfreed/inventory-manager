import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { RoutingForm } from '@features/routings/components/RoutingForm'
import { WorkCenterForm } from '@features/routings/components/WorkCenterForm'
import { ReportProductionForm } from '@features/workOrders/components/ReportProductionForm'
import { renderWithQueryClient } from '../testUtils'
import type { WorkOrder } from '@api/types'

vi.mock('@features/routings/api', () => ({
  getWorkCenters: vi.fn(),
}))
vi.mock('@features/locations/api/locations', () => ({
  listLocations: vi.fn(),
}))
vi.mock('@features/workOrders/api/workOrders', () => ({
  reportWorkOrderProduction: vi.fn(),
}))
vi.mock('uuid', () => ({
  v4: () => 'uuid-forms-test',
}))

import { getWorkCenters } from '@features/routings/api'
import { listLocations } from '@features/locations/api/locations'
import { reportWorkOrderProduction } from '@features/workOrders/api/workOrders'

const mockedGetWorkCenters = vi.mocked(getWorkCenters)
const mockedListLocations = vi.mocked(listLocations)
const mockedReportWorkOrderProduction = vi.mocked(reportWorkOrderProduction)

function getInputByLabelText(label: string, selector: 'input' | 'select' | 'textarea' = 'input') {
  const labelNode = screen.getByText(label)
  const root = labelNode.closest('div')
  if (!root) throw new Error(`Missing root for label ${label}`)
  const field = root.querySelector(selector)
  if (!field) throw new Error(`Missing ${selector} for label ${label}`)
  return field as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
}

function makeWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'wo-form',
    number: 'WO-FORM',
    status: 'released',
    kind: 'production',
    outputItemId: 'item-1',
    outputUom: 'kg',
    quantityPlanned: 4,
    quantityCompleted: 0,
    ...overrides,
  }
}

describe('forms validation behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedListLocations.mockResolvedValue({
      data: [{ id: 'loc-1', code: 'FG', name: 'Finished Goods' } as any],
    })
    mockedGetWorkCenters.mockResolvedValue([
      {
        id: 'wc-1',
        code: 'PACK',
        name: 'Packaging',
        locationId: 'loc-1',
        status: 'active',
        hourlyRate: 0,
        capacity: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ] as any)
    mockedReportWorkOrderProduction.mockResolvedValue({
      workOrderId: 'wo-form',
      productionReportId: 'pr-1',
      componentIssueMovementId: 'im-1',
      productionReceiptMovementId: 'rm-1',
      idempotencyKey: 'idemp-1',
      replayed: false,
    })
  })

  it('enforces required fields for WorkCenterForm', async () => {
    const onSubmit = vi.fn()
    renderWithQueryClient(<WorkCenterForm onSubmit={onSubmit} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Code is required')).toBeInTheDocument()
    expect(screen.getByText('Name is required')).toBeInTheDocument()
    expect(screen.getByText('Receive-to location is required')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('requires routing step production area before submit', async () => {
    const onSubmit = vi.fn()
    const { container } = renderWithQueryClient(
      <RoutingForm itemId="item-1" onSubmit={onSubmit} onCancel={vi.fn()} />,
    )

    fireEvent.change(getInputByLabelText('Name'), { target: { value: 'Routing Validation' } })
    fireEvent.change(getInputByLabelText('Version'), { target: { value: '1.0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Step' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(onSubmit).not.toHaveBeenCalled()
    })

    const stepSelect = container.querySelector('select[name="steps.0.workCenterId"]')
    expect(await screen.findByText('Packaging (PACK)')).toBeInTheDocument()
    fireEvent.change(stepSelect as HTMLSelectElement, { target: { value: 'wc-1' } })
    expect((stepSelect as HTMLSelectElement).value).toBe('wc-1')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1)
    })
  })

  it('disables report-production submit for terminal work order statuses', () => {
    renderWithQueryClient(
      <ReportProductionForm workOrder={makeWorkOrder({ status: 'completed' })} onRefetch={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: 'Report Production' })).toBeDisabled()
  })
})
