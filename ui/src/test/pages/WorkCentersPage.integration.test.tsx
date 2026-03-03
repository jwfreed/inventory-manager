import { describe, expect, it, beforeEach, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { WorkCentersPage } from '@features/routings/pages/WorkCentersPage'
import { renderWithQueryClient } from '../testUtils'

vi.mock('@features/routings/api', () => ({
  getWorkCenters: vi.fn(),
  createWorkCenter: vi.fn(),
  updateWorkCenter: vi.fn(),
}))

vi.mock('@features/locations/api/locations', () => ({
  listLocations: vi.fn(),
}))

import { getWorkCenters, createWorkCenter, updateWorkCenter } from '@features/routings/api'
import { listLocations } from '@features/locations/api/locations'

const mockedGetWorkCenters = vi.mocked(getWorkCenters)
const mockedCreateWorkCenter = vi.mocked(createWorkCenter)
const mockedUpdateWorkCenter = vi.mocked(updateWorkCenter)
const mockedListLocations = vi.mocked(listLocations)

describe('WorkCentersPage integration states', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedCreateWorkCenter.mockResolvedValue({} as any)
    mockedUpdateWorkCenter.mockResolvedValue({} as any)
    mockedListLocations.mockResolvedValue({
      data: [{ id: 'loc-1', code: 'FG', name: 'Finished Goods' } as any],
    })
  })

  it('renders populated table state', async () => {
    mockedGetWorkCenters.mockResolvedValue([
      {
        id: 'wc-1',
        code: 'PACK',
        name: 'Packaging',
        locationId: 'loc-1',
        status: 'active',
        description: '',
        hourlyRate: 0,
        capacity: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ] as any)

    renderWithQueryClient(<WorkCentersPage />)

    expect(await screen.findByRole('columnheader', { name: 'Receive-to Location' })).toBeInTheDocument()
    expect(screen.getByText('PACK')).toBeInTheDocument()
    expect(screen.getByText('Finished Goods (FG)')).toBeInTheDocument()
  })

  it('transitions from empty state to populated state after refetch', async () => {
    let rows: any[] = []
    mockedGetWorkCenters.mockImplementation(async () => rows)

    const { queryClient } = renderWithQueryClient(<WorkCentersPage />)
    expect(await screen.findByText('No production areas yet')).toBeInTheDocument()

    rows = [
      {
        id: 'wc-2',
        code: 'NIB',
        name: 'Nib Processing',
        locationId: 'loc-1',
        status: 'active',
        description: '',
        hourlyRate: 0,
        capacity: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['workCenters'] })
    })

    await waitFor(() => {
      expect(screen.getByText('NIB')).toBeInTheDocument()
    })
    expect(screen.queryByText('No production areas yet')).toBeNull()
  })

  it('opens and closes add modal in integration flow', async () => {
    mockedGetWorkCenters.mockResolvedValue([] as any)
    renderWithQueryClient(<WorkCentersPage />)

    await screen.findByText('No production areas yet')
    fireEvent.click(screen.getAllByRole('button', { name: 'Add Production Area' })[0] as HTMLButtonElement)
    expect(screen.getByRole('heading', { name: 'Add Production Area' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Add Production Area' })).toBeNull()
    })
  })
})
