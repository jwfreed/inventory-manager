/**
 * Targeted RBAC permission guard tests.
 *
 * Covers:
 * - location submit requires masterdata:write
 * - work center write actions require production:write
 *
 * Pattern: authPermissions variable controls what useAuth().hasPermission returns.
 * Default: all required permissions granted; individual tests override as needed.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithQueryClient } from '../testUtils'
import { LocationForm } from '@features/locations/components/LocationForm'
import { WorkCentersPage } from '@features/routings/pages/WorkCentersPage'

let authPermissions: string[] = ['masterdata:write', 'production:write']

vi.mock('@shared/auth', () => ({
  useAuth: () => ({
    hasPermission: (permission: string) => authPermissions.includes(permission),
  }),
}))

vi.mock('@features/locations/api/locations', () => ({
  createLocation: vi.fn(),
  updateLocation: vi.fn(),
  listLocations: vi.fn(),
}))

vi.mock('@features/routings/api', () => ({
  getWorkCenters: vi.fn(),
  createWorkCenter: vi.fn(),
  updateWorkCenter: vi.fn(),
}))

import { getWorkCenters } from '@features/routings/api'

const mockedGetWorkCenters = vi.mocked(getWorkCenters)

beforeEach(() => {
  vi.clearAllMocks()
  authPermissions = ['masterdata:write', 'production:write']
  mockedGetWorkCenters.mockResolvedValue([])
})

// ─── LocationForm ────────────────────────────────────────────────────────────

describe('LocationForm: masterdata:write guard', () => {
  it('disables submit button when masterdata:write is missing', () => {
    authPermissions = []
    renderWithQueryClient(<LocationForm />)
    expect(screen.getByRole('button', { name: /create location/i })).toBeDisabled()
  })

  it('shows permission-denied helper text when masterdata:write is missing', () => {
    authPermissions = []
    renderWithQueryClient(<LocationForm />)
    expect(
      screen.getByText('You need master data write permission to save locations.'),
    ).toBeInTheDocument()
  })

  it('enables submit button when masterdata:write is present', () => {
    authPermissions = ['masterdata:write']
    renderWithQueryClient(<LocationForm />)
    expect(screen.getByRole('button', { name: /create location/i })).not.toBeDisabled()
  })

  it('does not show permission-denied helper text when masterdata:write is present', () => {
    authPermissions = ['masterdata:write']
    renderWithQueryClient(<LocationForm />)
    expect(
      screen.queryByText('You need master data write permission to save locations.'),
    ).toBeNull()
  })
})

// ─── WorkCentersPage ─────────────────────────────────────────────────────────

describe('WorkCentersPage: production:write guard', () => {
  it('disables Add Production Area button when production:write is missing', async () => {
    authPermissions = []
    renderWithQueryClient(<WorkCentersPage />)
    const buttons = await screen.findAllByRole('button', { name: /add production area/i })
    expect(buttons.every((btn) => btn.hasAttribute('disabled'))).toBe(true)
  })

  it('shows permission-denied helper text when production:write is missing', async () => {
    authPermissions = []
    renderWithQueryClient(<WorkCentersPage />)
    expect(
      await screen.findByText('You need production write permission to add or edit production areas.'),
    ).toBeInTheDocument()
  })

  it('enables Add Production Area button when production:write is present', async () => {
    authPermissions = ['production:write']
    renderWithQueryClient(<WorkCentersPage />)
    const buttons = await screen.findAllByRole('button', { name: /add production area/i })
    expect(buttons.every((btn) => !btn.hasAttribute('disabled'))).toBe(true)
  })

  it('does not show permission-denied helper text when production:write is present', async () => {
    authPermissions = ['production:write']
    renderWithQueryClient(<WorkCentersPage />)
    // Wait for loading to finish
    await screen.findAllByRole('button', { name: /add production area/i })
    expect(
      screen.queryByText('You need production write permission to add or edit production areas.'),
    ).toBeNull()
  })
})
