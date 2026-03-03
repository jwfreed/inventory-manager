import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { RoutingForm } from '@features/routings/components/RoutingForm'
import { renderWithQueryClient } from '../testUtils'

vi.mock('@features/routings/api', () => ({
  getWorkCenters: vi.fn(),
}))

vi.mock('@features/locations/api/locations', () => ({
  listLocations: vi.fn(),
}))

import { getWorkCenters } from '@features/routings/api'
import { listLocations } from '@features/locations/api/locations'

const mockedGetWorkCenters = vi.mocked(getWorkCenters)
const mockedListLocations = vi.mocked(listLocations)

function getStepCount() {
  return screen.queryAllByText('Production Area').length
}

function getInputByLabelText(label: string) {
  const labelNode = screen.getByText(label)
  const root = labelNode.closest('div')
  if (!root) throw new Error(`Unable to find parent for label: ${label}`)
  const field = root.querySelector('input')
  if (!field) throw new Error(`Unable to find input for label: ${label}`)
  return field as HTMLInputElement
}

describe('RoutingForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('adds and removes routing steps', async () => {
    mockedGetWorkCenters.mockResolvedValue([])
    mockedListLocations.mockResolvedValue({ data: [] })
    const onSubmit = vi.fn()

    const { container } = renderWithQueryClient(
      <RoutingForm itemId="item-1" onSubmit={onSubmit} onCancel={vi.fn()} />,
    )

    expect(getStepCount()).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Add Step' }))
    expect(getStepCount()).toBe(1)

    const removeButtons = container.querySelectorAll('button.text-red-600')
    expect(removeButtons.length).toBe(1)
    fireEvent.click(removeButtons[0] as HTMLButtonElement)
    expect(getStepCount()).toBe(0)
  })

  it('shows receive-to hint when selected production area has no location', async () => {
    mockedGetWorkCenters.mockResolvedValue([
      {
        id: 'wc-1',
        code: 'MIX',
        name: 'Mixing',
        locationId: null,
        status: 'active',
        hourlyRate: 0,
        capacity: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ] as any)
    mockedListLocations.mockResolvedValue({ data: [] })

    const { container } = renderWithQueryClient(
      <RoutingForm itemId="item-1" onSubmit={vi.fn()} onCancel={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add Step' }))

    expect(await screen.findByText('Mixing (MIX)')).toBeInTheDocument()
    const select = container.querySelector('select[name="steps.0.workCenterId"]')
    expect(select).toBeTruthy()
    fireEvent.change(select as HTMLSelectElement, { target: { value: 'wc-1', name: 'steps.0.workCenterId' } })

    expect(
      await screen.findByText('Receives to: Not set — system defaults will be used'),
    ).toBeInTheDocument()
  })

  it('shows resolved receive-to hint when location is available', async () => {
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
    mockedListLocations.mockResolvedValue({
      data: [{ id: 'loc-1', code: 'FG', name: 'Finished Goods' } as any],
    })

    const { container } = renderWithQueryClient(
      <RoutingForm itemId="item-1" onSubmit={vi.fn()} onCancel={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add Step' }))

    expect(await screen.findByText('Packaging (PACK)')).toBeInTheDocument()
    const select = container.querySelector('select[name="steps.0.workCenterId"]')
    fireEvent.change(select as HTMLSelectElement, { target: { value: 'wc-1', name: 'steps.0.workCenterId' } })

    expect(await screen.findByText('Receives to: Finished Goods (FG)')).toBeInTheDocument()
  })

  it('shows fallback receive-to hint when selected location cannot be resolved', async () => {
    mockedGetWorkCenters.mockResolvedValue([
      {
        id: 'wc-1',
        code: 'ROAST',
        name: 'Roasting',
        locationId: 'loc-missing',
        status: 'active',
        hourlyRate: 0,
        capacity: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ] as any)
    mockedListLocations.mockResolvedValue({ data: [] })

    const { container } = renderWithQueryClient(
      <RoutingForm itemId="item-1" onSubmit={vi.fn()} onCancel={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add Step' }))

    expect(await screen.findByText('Roasting (ROAST)')).toBeInTheDocument()
    const select = container.querySelector('select[name="steps.0.workCenterId"]')
    fireEvent.change(select as HTMLSelectElement, { target: { value: 'wc-1', name: 'steps.0.workCenterId' } })

    expect(
      await screen.findByText('Receives to: Unknown (system defaults will be used)'),
    ).toBeInTheDocument()
  })

  it('submits once step production area is selected', async () => {
    mockedGetWorkCenters.mockResolvedValue([
      {
        id: 'wc-1',
        code: 'PACK',
        name: 'Packaging',
        locationId: null,
        status: 'active',
        hourlyRate: 0,
        capacity: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ] as any)
    mockedListLocations.mockResolvedValue({ data: [] })
    const onSubmit = vi.fn()

    const { container } = renderWithQueryClient(
      <RoutingForm itemId="item-1" onSubmit={onSubmit} onCancel={vi.fn()} />,
    )

    fireEvent.change(getInputByLabelText('Name'), { target: { value: 'Routing A' } })
    fireEvent.change(getInputByLabelText('Version'), { target: { value: '1.0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Step' }))

    const select = container.querySelector('select[name="steps.0.workCenterId"]')
    expect(await screen.findByText('Packaging (PACK)')).toBeInTheDocument()
    fireEvent.change(select as HTMLSelectElement, { target: { value: 'wc-1', name: 'steps.0.workCenterId' } })
    expect((select as HTMLSelectElement).value).toBe('wc-1')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1)
    })
  })
})
