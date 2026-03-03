import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { WorkCentersPage } from '@features/routings/pages/WorkCentersPage'
import { WorkCenterForm } from '@features/routings/components/WorkCenterForm'
import { RoutingForm } from '@features/routings/components/RoutingForm'
import { ReportProductionForm } from '@features/workOrders/components/ReportProductionForm'
import { renderWithQueryClient } from '../testUtils'
import type { WorkCenter } from '@features/routings/types'
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
  v4: vi.fn(() => 'smoke-request-id'),
}))

import { getWorkCenters } from '@features/routings/api'
import { listLocations } from '@features/locations/api/locations'

const mockedGetWorkCenters = vi.mocked(getWorkCenters)
const mockedListLocations = vi.mocked(listLocations)

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeWorkCenter(overrides: Partial<WorkCenter>): WorkCenter {
  return {
    id: 'wc-default',
    code: 'WC',
    name: 'Default Area',
    description: '',
    locationId: null,
    hourlyRate: 0,
    capacity: 1,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'wo-smoke',
    number: 'WO-SMOKE',
    status: 'released',
    kind: 'production',
    outputItemId: 'item-1',
    outputUom: 'kg',
    quantityPlanned: 10,
    quantityCompleted: 2,
    ...overrides,
  }
}

function getInputByLabelText(label: string, selector: 'input' | 'select' | 'textarea' = 'input') {
  const labelNode = screen.getByText(label)
  const root = labelNode.closest('div')
  if (!root) throw new Error(`Missing root for label ${label}`)
  const field = root.querySelector(selector)
  if (!field) throw new Error(`Missing ${selector} for label ${label}`)
  return field as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
}

describe('manufacturing smoke suite', () => {
  it('shows Production Areas optional empty state with arrow example copy', async () => {
    mockedGetWorkCenters.mockResolvedValue([])
    mockedListLocations.mockResolvedValue({ data: [] })

    renderWithQueryClient(<WorkCentersPage />)

    expect(
      await screen.findByText(/Optional.*output is received.*reporting production.*routings/i),
    ).toBeInTheDocument()
    expect(screen.getByText('No production areas yet')).toBeInTheDocument()
    expect(
      screen.getByText(/Example:\s*Nib Processing → NIB Warehouse,\s*Packaging → Finished Goods\./),
    ).toBeInTheDocument()
  })

  it('renders Receive-to Location column and uses Loading/Not set/Unknown (no unmapped UUID shown)', async () => {
    const unmappedLocationId = 'loc-unmapped-uuid-1234'
    const workCenters = [
      makeWorkCenter({ id: 'wc-1', code: 'MIX', name: 'Mixing', locationId: null }),
      makeWorkCenter({ id: 'wc-2', code: 'PACK', name: 'Packaging', locationId: unmappedLocationId }),
    ]

    mockedGetWorkCenters.mockResolvedValue(workCenters)
    const locationsLoadingDeferred = createDeferred<{ data: Array<{ id: string; code: string; name: string }> }>()
    mockedListLocations.mockImplementationOnce(() => locationsLoadingDeferred.promise)

    const first = renderWithQueryClient(<WorkCentersPage />)
    expect(await screen.findByRole('columnheader', { name: 'Receive-to Location' })).toBeInTheDocument()
    expect(screen.getByText('Not set')).toBeInTheDocument()
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    locationsLoadingDeferred.resolve({ data: [] })
    await waitFor(() => {
      expect(first.queryClient.isFetching()).toBe(0)
    })
    first.unmount()

    mockedGetWorkCenters.mockResolvedValue(workCenters)
    mockedListLocations.mockResolvedValueOnce({ data: [] })
    renderWithQueryClient(<WorkCentersPage />)

    expect(await screen.findByText('Unknown')).toBeInTheDocument()
    expect(screen.getByText('Not set')).toBeInTheDocument()
    expect(screen.queryByText(unmappedLocationId)).toBeNull()
  })

  it('requires receive-to location in Production Area form', async () => {
    mockedListLocations.mockResolvedValue({
      data: [{ id: 'loc-1', code: 'FG', name: 'Finished Goods' } as any],
    })

    renderWithQueryClient(<WorkCenterForm onSubmit={vi.fn()} onCancel={vi.fn()} />)

    fireEvent.change(getInputByLabelText('Code'), { target: { value: 'PACK' } })
    fireEvent.change(getInputByLabelText('Production Area Name'), { target: { value: 'Packaging' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Receive-to location is required')).toBeInTheDocument()
  })

  it('shows Routing receives-to hint for Loading, Not set, and resolved location', async () => {
    mockedGetWorkCenters.mockResolvedValueOnce([
      makeWorkCenter({ id: 'wc-load', code: 'BLEND', name: 'Blend', locationId: 'loc-1' }),
    ])
    const routingLocationsLoadingDeferred = createDeferred<
      { data: Array<{ id: string; code: string; name: string }> }
    >()
    mockedListLocations.mockImplementationOnce(() => routingLocationsLoadingDeferred.promise)

    const loadRender = renderWithQueryClient(
      <RoutingForm itemId="item-1" onSubmit={vi.fn()} onCancel={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add Step' }))
    expect(await screen.findByText('Blend (BLEND)')).toBeInTheDocument()
    const loadSelect = loadRender.container.querySelector('select[name="steps.0.workCenterId"]')
    fireEvent.change(loadSelect as HTMLSelectElement, {
      target: { value: 'wc-load', name: 'steps.0.workCenterId' },
    })
    expect(await screen.findByText('Receives to: Loading...')).toBeInTheDocument()
    routingLocationsLoadingDeferred.resolve({ data: [] })
    await waitFor(() => {
      expect(loadRender.queryClient.isFetching()).toBe(0)
    })
    loadRender.unmount()

    mockedGetWorkCenters.mockResolvedValueOnce([
      makeWorkCenter({ id: 'wc-not-set', code: 'NIB', name: 'Nib Processing', locationId: null }),
    ])
    mockedListLocations.mockResolvedValueOnce({ data: [] })
    const notSetRender = renderWithQueryClient(
      <RoutingForm itemId="item-1" onSubmit={vi.fn()} onCancel={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add Step' }))
    expect(await screen.findByText('Nib Processing (NIB)')).toBeInTheDocument()
    const notSetSelect = notSetRender.container.querySelector('select[name="steps.0.workCenterId"]')
    fireEvent.change(notSetSelect as HTMLSelectElement, {
      target: { value: 'wc-not-set', name: 'steps.0.workCenterId' },
    })
    expect(
      await screen.findByText('Receives to: Not set — system defaults will be used'),
    ).toBeInTheDocument()
    notSetRender.unmount()

    mockedGetWorkCenters.mockResolvedValueOnce([
      makeWorkCenter({ id: 'wc-pack', code: 'PACK', name: 'Packaging', locationId: 'loc-fg' }),
    ])
    mockedListLocations.mockResolvedValueOnce({
      data: [{ id: 'loc-fg', code: 'FG', name: 'Finished Goods' } as any],
    })
    const resolvedRender = renderWithQueryClient(
      <RoutingForm itemId="item-1" onSubmit={vi.fn()} onCancel={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add Step' }))
    expect(await screen.findByText('Packaging (PACK)')).toBeInTheDocument()
    const resolvedSelect = resolvedRender.container.querySelector('select[name="steps.0.workCenterId"]')
    fireEvent.change(resolvedSelect as HTMLSelectElement, {
      target: { value: 'wc-pack', name: 'steps.0.workCenterId' },
    })
    expect(await screen.findByText('Receives to: Finished Goods (FG)')).toBeInTheDocument()
  })

  it('shows Report Production preview with System default fallback and source labels', async () => {
    const { rerender } = renderWithQueryClient(
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

    rerender(
      <ReportProductionForm
        workOrder={makeWorkOrder({
          reportProductionReceiveToLocationName: 'Finished Goods',
          reportProductionReceiveToLocationCode: 'FG',
          reportProductionReceiveToSource: 'routing_snapshot',
        })}
        onRefetch={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText(/Receive-to location:/)).toBeInTheDocument()
    })
    expect(screen.getByText(/Finished Goods \(FG\)/)).toBeInTheDocument()
    expect(screen.getByText(/Routing snapshot/)).toBeInTheDocument()
  })
})
