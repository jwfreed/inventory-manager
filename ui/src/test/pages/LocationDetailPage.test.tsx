import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
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
  useLocationsList: vi.fn(),
}))

vi.mock('../../features/locations/api/locations', () => ({
  updateLocation: vi.fn(),
  createLocation: vi.fn(),
}))

import { useLocation, useLocationInventorySummary, useLocationsList } from '../../features/locations/queries'
import { updateLocation } from '../../features/locations/api/locations'

const mockedUseLocation = vi.mocked(useLocation)
const mockedUseLocationInventorySummary = vi.mocked(useLocationInventorySummary)
const mockedUseLocationsList = vi.mocked(useLocationsList)
const mockedUpdateLocation = vi.mocked(updateLocation)

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
  name: 'Factory Raw Material Store',
  code: 'FACTORY_RM_STORE',
  type: 'bin',
  role: 'SELLABLE',
  isSellable: true,
  active: true,
  path: 'MAIN/FACTORY_RM_STORE',
  depth: 1,
  parentLocationId: 'warehouse-1',
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
  mockedUseLocationsList.mockReturnValue({
    data: {
      data: [
        { id: 'warehouse-1', code: 'MAIN', name: 'Main Warehouse', type: 'warehouse', active: true },
        locationData,
      ],
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as any)
  mockedUpdateLocation.mockResolvedValue(locationData as any)
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

  it('displays inventory behavior with domain labels and the production reservation limitation', () => {
    renderPage()

    expect(screen.getByText('Inventory behavior')).toBeInTheDocument()
    expect(screen.getAllByText('Raw material store').length).toBeGreaterThan(0)
    expect(screen.getByText('Reservable inventory enabled')).toBeInTheDocument()
    expect(screen.getByText('Can consume for production')).toBeInTheDocument()
    // "Reservable inventory" now appears as the capability label (was "Can reserve for sales")
    // It also appears in the backend-role card (SELLABLE → 'Reservable inventory') and context rail.
    expect(screen.getAllByText('Reservable inventory').length).toBeGreaterThan(0)
    expect(screen.getByText('Current production reservation limitation')).toBeInTheDocument()
    expect(
      screen.getByText(/technically marked reservable even though it is not a customer-facing sales location/i),
    ).toBeInTheDocument()
  })

  it('shows role selector and reservable-inventory checkbox in the edit form; other capabilities are read-only', () => {
    renderPage()

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit location' })[0])

    expect(screen.getByLabelText(/Role/i)).toBeInTheDocument()
    // Only the reservable checkbox is editable; other capabilities are derived indicators
    expect(screen.getByLabelText('Reservable inventory')).toBeInTheDocument()
    // Derived indicators are read-only — no checkbox for them
    expect(screen.queryByLabelText('Can receive inventory')).toBeNull()
    expect(screen.queryByLabelText('Can store raw materials')).toBeNull()
    expect(screen.queryByLabelText('Can consume for production')).toBeNull()
    // Derived indicators still appear as text (may appear in both detail view and form)
    expect(screen.getAllByText('Can consume for production').length).toBeGreaterThan(0)
    expect(screen.getByText('Derived capabilities')).toBeInTheDocument()
  })

  it('submits the backend role and sellable payload for a reservable raw-material store', async () => {
    renderPage()

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit location' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(mockedUpdateLocation).toHaveBeenCalledWith(
        'loc-1',
        expect.objectContaining({
          code: 'FACTORY_RM_STORE',
          role: 'SELLABLE',
          isSellable: true,
        }),
      )
    })
  })

  it('surfaces backend validation errors when reservable inventory cannot be disabled', async () => {
    mockedUpdateLocation.mockRejectedValueOnce({
      status: 409,
      message: 'Reservable inventory cannot be disabled while this location has open reservations.',
    })
    renderPage()

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit location' })[0])
    fireEvent.click(screen.getByLabelText('Reservable inventory'))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Save failed')).toBeInTheDocument()
    expect(screen.getByText(/cannot be disabled while this location has open reservations/i)).toBeInTheDocument()
  })
})
