import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '../testUtils'
import LocationDetailPage from '../../features/locations/pages/LocationDetailPage'

let authPermissions: string[] = ['masterdata:write']

vi.mock('@shared/auth', () => ({
  useAuth: () => ({
    hasPermission: (permission: string) => authPermissions.includes(permission),
  }),
}))

vi.mock('../../features/locations/queries', () => ({
  useLocation: vi.fn(),
  useLocationInventorySummary: vi.fn(),
}))

import { useLocation, useLocationInventorySummary } from '../../features/locations/queries'

const mockedUseLocation = vi.mocked(useLocation)
const mockedUseLocationInventorySummary = vi.mocked(useLocationInventorySummary)

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: '/locations/:id',
        element: <LocationDetailPage />,
      },
      {
        path: '/not-found',
        element: <div>not found</div>,
      },
    ],
    { initialEntries: ['/locations/loc-1'] },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

const locationData = {
  id: 'loc-1',
  name: 'Warehouse A',
  code: 'WH-A',
  type: 'storage',
  active: true,
  path: 'WH/WH-A',
  depth: 1,
  parentLocationId: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  authPermissions = ['masterdata:write']
  mockedUseLocation.mockReturnValue({
    data: locationData,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as any)
  mockedUseLocationInventorySummary.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as any)
})

describe('LocationDetailPage: masterdata:write guard on edit', () => {
  it('enables Edit location buttons when masterdata:write is present', () => {
    renderPage()
    const editButtons = screen.getAllByRole('button', { name: 'Edit location' })
    expect(editButtons.every((btn) => !btn.hasAttribute('disabled'))).toBe(true)
  })

  it('disables Edit location buttons when masterdata:write is absent', () => {
    authPermissions = []
    renderPage()
    const editButtons = screen.getAllByRole('button', { name: 'Edit location' })
    expect(editButtons.every((btn) => btn.hasAttribute('disabled'))).toBe(true)
  })

  it('does not open edit form when unauthorized user clicks Edit location', () => {
    authPermissions = []
    renderPage()
    const editButtons = screen.getAllByRole('button', { name: 'Edit location' })
    editButtons.forEach((btn) => fireEvent.click(btn))
    // form should not appear — the panel still shows the EmptyState
    expect(screen.queryByRole('button', { name: /save|update|create location/i })).toBeNull()
  })

  it('opens edit form when authorized user clicks Edit location', () => {
    renderPage()
    // Click the first Edit location button (panel actions)
    const editButtons = screen.getAllByRole('button', { name: 'Edit location' })
    fireEvent.click(editButtons[0])
    // After clicking, panel actions button label toggles to "Hide form"
    expect(screen.getByRole('button', { name: 'Hide form' })).toBeInTheDocument()
  })
})
