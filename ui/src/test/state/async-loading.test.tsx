import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { WorkCentersPage } from '@features/routings/pages/WorkCentersPage'
import { ReportProductionForm } from '@features/workOrders/components/ReportProductionForm'
import { renderWithQueryClient } from '../testUtils'
import type { WorkOrder } from '@api/types'

vi.mock('@features/routings/api', () => ({
  getWorkCenters: vi.fn(),
  createWorkCenter: vi.fn(),
  updateWorkCenter: vi.fn(),
}))
vi.mock('@features/locations/api/locations', () => ({
  listLocations: vi.fn(),
}))
vi.mock('@features/workOrders/api/workOrders', () => ({
  reportWorkOrderProduction: vi.fn(),
}))
vi.mock('uuid', () => ({
  v4: () => 'uuid-state-test',
}))

import { getWorkCenters } from '@features/routings/api'
import { listLocations } from '@features/locations/api/locations'
import { reportWorkOrderProduction } from '@features/workOrders/api/workOrders'

const mockedGetWorkCenters = vi.mocked(getWorkCenters)
const mockedListLocations = vi.mocked(listLocations)
const mockedReportWorkOrderProduction = vi.mocked(reportWorkOrderProduction)

function makeWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'wo-state',
    number: 'WO-STATE',
    status: 'released',
    kind: 'production',
    outputItemId: 'item-1',
    outputUom: 'kg',
    quantityPlanned: 5,
    quantityCompleted: 0,
    ...overrides,
  }
}

describe('UI async and state rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders loading state for WorkCentersPage', () => {
    mockedGetWorkCenters.mockImplementation(() => new Promise(() => undefined))
    mockedListLocations.mockResolvedValue({ data: [] })

    renderWithQueryClient(<WorkCentersPage />)
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('renders error alert for report production failures', async () => {
    mockedReportWorkOrderProduction.mockRejectedValue({ message: 'Network down' })
    renderWithQueryClient(<ReportProductionForm workOrder={makeWorkOrder()} onRefetch={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Report Production' }))
    expect(await screen.findByText('Report failed')).toBeInTheDocument()
    expect(screen.getByText('Network down')).toBeInTheDocument()
  })

  it('disables submit while report production mutation is pending', async () => {
    mockedReportWorkOrderProduction.mockImplementation(
      () => new Promise(() => undefined),
    )
    renderWithQueryClient(<ReportProductionForm workOrder={makeWorkOrder()} onRefetch={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Report Production' }))
    expect(await screen.findByRole('button', { name: 'Posting...' })).toBeDisabled()
  })
})
