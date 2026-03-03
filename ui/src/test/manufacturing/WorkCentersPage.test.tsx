import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { WorkCentersPage } from '@features/routings/pages/WorkCentersPage'
import { renderWithQueryClient } from '../testUtils'
import type { WorkCenter } from '@features/routings/types'

vi.mock('@features/routings/api', () => ({
  getWorkCenters: vi.fn(),
  createWorkCenter: vi.fn(),
  updateWorkCenter: vi.fn(),
}))

vi.mock('@features/locations/api/locations', () => ({
  listLocations: vi.fn(),
}))

import {
  getWorkCenters,
  createWorkCenter,
  updateWorkCenter,
} from '@features/routings/api'
import { listLocations } from '@features/locations/api/locations'

const mockedGetWorkCenters = vi.mocked(getWorkCenters)
const mockedCreateWorkCenter = vi.mocked(createWorkCenter)
const mockedUpdateWorkCenter = vi.mocked(updateWorkCenter)
const mockedListLocations = vi.mocked(listLocations)

function getFieldByLabelText(
  label: string,
  selector: 'input' | 'select' | 'textarea' = 'input',
) {
  const labelNode = screen.getByText(label)
  const root = labelNode.closest('div')
  if (!root) throw new Error(`Unable to find field root for label: ${label}`)
  const field = root.querySelector(selector)
  if (!field) throw new Error(`Unable to find ${selector} for label: ${label}`)
  return field as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
}

function clickPrimaryAddProductionAreaButton() {
  const buttons = screen.getAllByRole('button', { name: 'Add Production Area' })
  fireEvent.click(buttons[0] as HTMLButtonElement)
}

const sampleWorkCenters: WorkCenter[] = [
  {
    id: 'wc-no-location',
    code: 'NOLOC',
    name: 'No Location',
    locationId: null,
    description: '',
    hourlyRate: 0,
    capacity: 1,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'wc-resolved',
    code: 'PACK',
    name: 'Packaging',
    locationId: 'loc-1',
    description: '',
    hourlyRate: 0,
    capacity: 1,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'wc-unknown',
    code: 'UNK',
    name: 'Unknown',
    locationId: 'loc-missing',
    description: '',
    hourlyRate: 0,
    capacity: 1,
    status: 'inactive',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
]

describe('WorkCentersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedCreateWorkCenter.mockResolvedValue(sampleWorkCenters[0])
    mockedUpdateWorkCenter.mockResolvedValue(sampleWorkCenters[0])
  })

  it('renders empty state and toggles "Learn how this works"', async () => {
    mockedGetWorkCenters.mockResolvedValue([])
    mockedListLocations.mockResolvedValue({ data: [] })

    renderWithQueryClient(<WorkCentersPage />)

    expect(await screen.findByText('No production areas yet')).toBeInTheDocument()
    expect(screen.queryByText(/Routing steps can use a production area location/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Learn how this works' }))
    expect(
      screen.getByText(/Routing steps can use a production area location as the receive-to target/i),
    ).toBeInTheDocument()
  })

  it('opens modal when Add Production Area is clicked', async () => {
    mockedGetWorkCenters.mockResolvedValue([])
    mockedListLocations.mockResolvedValue({ data: [] })

    renderWithQueryClient(<WorkCentersPage />)

    await screen.findByText('No production areas yet')
    clickPrimaryAddProductionAreaButton()

    expect(screen.getByRole('heading', { name: 'Add Production Area' })).toBeInTheDocument()
    expect(getFieldByLabelText('Code')).toBeInTheDocument()
  })

  it('renders receive-to labels for not set, resolved, and fallback location states', async () => {
    mockedGetWorkCenters.mockResolvedValue(sampleWorkCenters)
    mockedListLocations.mockResolvedValue({
      data: [{ id: 'loc-1', code: 'FG', name: 'Finished Goods', type: 'storage', active: true } as any],
    })

    renderWithQueryClient(<WorkCentersPage />)

    expect(await screen.findByText('NOLOC')).toBeInTheDocument()
    expect(screen.getByText('Not set')).toBeInTheDocument()
    expect(screen.getByText('Finished Goods (FG)')).toBeInTheDocument()
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0)
  })

  it('renders fallback location string when locations are unavailable', async () => {
    mockedGetWorkCenters.mockResolvedValue([sampleWorkCenters[1]])
    mockedListLocations.mockResolvedValue({ data: [] })

    renderWithQueryClient(<WorkCentersPage />)

    await screen.findByText('PACK')
    expect(screen.getByText('Unknown')).toBeInTheDocument()
  })

  it('saves new production area via modal form submit', async () => {
    mockedGetWorkCenters.mockResolvedValue([])
    mockedListLocations.mockResolvedValue({
      data: [{ id: 'loc-1', code: 'FG', name: 'Finished Goods', type: 'storage', active: true } as any],
    })

    renderWithQueryClient(<WorkCentersPage />)
    await screen.findByText('No production areas yet')

    clickPrimaryAddProductionAreaButton()
    fireEvent.change(getFieldByLabelText('Code'), { target: { value: 'PACK' } })
    fireEvent.change(getFieldByLabelText('Production Area Name'), { target: { value: 'Packaging' } })
    fireEvent.change(getFieldByLabelText('Location (Receive-to)', 'select'), {
      target: { value: 'loc-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockedCreateWorkCenter).toHaveBeenCalledTimes(1)
    })
  })

  it('closes modal when clicking backdrop', async () => {
    mockedGetWorkCenters.mockResolvedValue([])
    mockedListLocations.mockResolvedValue({ data: [] })

    const { container } = renderWithQueryClient(<WorkCentersPage />)
    await screen.findByText('No production areas yet')
    clickPrimaryAddProductionAreaButton()

    const backdrop = container.querySelector('.bg-gray-500.bg-opacity-75')
    expect(backdrop).toBeTruthy()
    fireEvent.click(backdrop as Element)

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Add Production Area' })).toBeNull()
    })
  })
})
