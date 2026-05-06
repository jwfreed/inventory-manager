import { describe, expect, it, beforeEach, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { SupplierScorecardsPage } from '@features/vendors/pages/SupplierScorecardsPage'
import { vendorRoutes } from '@features/vendors/routes'
import { RequirePermission } from '@shared/auth'
import { AuthContext, type AuthContextValue } from '../../lib/authContext'
import { renderWithQueryClient } from '../testUtils'

const {
  getSupplierScorecardMock,
  getSupplierScorecardsMock,
  getTopSuppliersByDeliveryMock,
  getTopSuppliersByQualityMock,
  getSuppliersWithQualityIssuesMock,
} = vi.hoisted(() => ({
  getSupplierScorecardMock: vi.fn(),
  getSupplierScorecardsMock: vi.fn(),
  getTopSuppliersByDeliveryMock: vi.fn(),
  getTopSuppliersByQualityMock: vi.fn(),
  getSuppliersWithQualityIssuesMock: vi.fn(),
}))

vi.mock('@api/reports', () => ({
  getSupplierScorecard: (...args: unknown[]) => getSupplierScorecardMock(...args),
  getSupplierScorecards: (...args: unknown[]) => getSupplierScorecardsMock(...args),
  getTopSuppliersByDelivery: (...args: unknown[]) => getTopSuppliersByDeliveryMock(...args),
  getTopSuppliersByQuality: (...args: unknown[]) => getTopSuppliersByQualityMock(...args),
  getSuppliersWithQualityIssues: (...args: unknown[]) => getSuppliersWithQualityIssuesMock(...args),
}))

const scorecard = {
  vendorId: 'vendor-1',
  vendorCode: 'SUP-1',
  vendorName: 'Siam Supplier',
  totalPurchaseOrders: 4,
  totalPoLines: 8,
  totalReceipts: 3,
  onTimeReceipts: 2,
  lateReceipts: 1,
  onTimeDeliveryRate: 90,
  averageDaysLate: 1.5,
  totalQcEvents: 2,
  acceptedQuantity: 12,
  rejectedQuantity: 1,
  heldQuantity: 0,
  totalNcrs: 1,
  openNcrs: 0,
  closedNcrs: 1,
  qualityRate: 92,
  returnToVendorCount: 0,
  scrapCount: 0,
  reworkCount: 0,
  useAsIsCount: 1,
}

function authValue(permissions: string[]): AuthContextValue {
  return {
    status: 'authenticated',
    accessToken: 'token',
    user: { id: 'user-1', email: 'user@example.com' },
    tenant: { id: 'tenant-1', name: 'Tenant One', slug: 'tenant-one' },
    role: permissions.includes('purchasing:read') ? 'admin' : 'operator',
    permissions,
    logoutReason: null,
    login: async () => undefined,
    bootstrap: async () => undefined,
    logout: async () => undefined,
    refresh: async () => undefined,
    hasPermission: (permission) => permissions.includes(permission),
    hasAnyPermission: (required) => required.some((permission) => permissions.includes(permission)),
    hasAllPermissions: (required) => required.every((permission) => permissions.includes(permission)),
  }
}

function renderDetailRoute(permissions: string[]) {
  const router = createMemoryRouter(
    [
      {
        path: '/supplier-scorecards/:vendorId',
        element: (
          <AuthContext.Provider value={authValue(permissions)}>
            <RequirePermission permission="purchasing:read">
              <SupplierScorecardsPage />
            </RequirePermission>
          </AuthContext.Provider>
        ),
      },
      {
        path: '/forbidden',
        element: <div>Forbidden Page</div>,
      },
    ],
    { initialEntries: ['/supplier-scorecards/vendor-1'] },
  )

  return renderWithQueryClient(<RouterProvider router={router} />)
}

describe('SupplierScorecardsPage routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSupplierScorecardMock.mockResolvedValue({ data: scorecard })
    getSupplierScorecardsMock.mockResolvedValue({ data: [scorecard] })
    getTopSuppliersByDeliveryMock.mockResolvedValue({ data: [scorecard] })
    getTopSuppliersByQualityMock.mockResolvedValue({ data: [scorecard] })
    getSuppliersWithQualityIssuesMock.mockResolvedValue({ data: [] })
  })

  it('defines the supplier-scorecard detail route with purchasing read permission', () => {
    const detailRoute = vendorRoutes.find((route) => route.path === 'supplier-scorecards/:vendorId')

    expect(detailRoute?.handle?.permission).toBe('purchasing:read')
  })

  it('loads the supplier-specific scorecard for users with purchasing read permission', async () => {
    renderDetailRoute(['purchasing:read'])

    expect(await screen.findByText('Siam Supplier')).toBeInTheDocument()
    expect(screen.getByText('SUP-1')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to all supplier scorecards' })).toHaveAttribute(
      'href',
      '/supplier-scorecards',
    )
    expect(getSupplierScorecardMock).toHaveBeenCalledWith('vendor-1')
    expect(getSupplierScorecardsMock).not.toHaveBeenCalled()
  })

  it('keeps the supplier-specific scorecard route forbidden without purchasing read permission', async () => {
    renderDetailRoute([])

    expect(await screen.findByText('Forbidden Page')).toBeInTheDocument()
    expect(getSupplierScorecardMock).not.toHaveBeenCalled()
  })
})
