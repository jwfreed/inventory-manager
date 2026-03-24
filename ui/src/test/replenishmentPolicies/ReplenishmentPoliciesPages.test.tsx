import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithQueryClient } from '../testUtils'
import ReplenishmentPoliciesListPage from '@features/replenishmentPolicies/pages/ReplenishmentPoliciesListPage'
import ReplenishmentPolicyCreatePage from '@features/replenishmentPolicies/pages/ReplenishmentPolicyCreatePage'
import ReplenishmentPolicyDetailPage from '@features/replenishmentPolicies/pages/ReplenishmentPolicyDetailPage'

const mocks = vi.hoisted(() => ({
  useReplenishmentPoliciesListMock: vi.fn(),
  useReplenishmentPolicyMock: vi.fn(),
  useItemsListMock: vi.fn(),
  useItemMock: vi.fn(),
  useLocationsListMock: vi.fn(),
  useLocationMock: vi.fn(),
  createReplenishmentPolicyMock: vi.fn(),
  invalidateQueriesMock: vi.fn(),
  navigateMock: vi.fn(),
}))

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query')
  return {
    ...actual,
    useMutation: (options: { mutationFn: (payload: unknown) => Promise<unknown>; onSuccess?: (value: any) => void }) => ({
      isPending: false,
      error: null,
      mutate: async (payload: unknown) => {
        const created = await options.mutationFn(payload)
        options.onSuccess?.(created)
      },
    }),
    useQueryClient: () => ({
      invalidateQueries: mocks.invalidateQueriesMock,
    }),
  }
})

vi.mock('@features/replenishmentPolicies/queries', () => ({
  replenishmentPolicyQueryKeys: {
    prefix: () => ['planning', 'replenishment-policies'] as const,
    list: (params: { limit?: number; offset?: number } = {}) => ['planning', 'replenishment-policies', params] as const,
    detail: (id: string) => ['planning', 'replenishment-policies', 'detail', id] as const,
  },
  useReplenishmentPoliciesList: (...args: unknown[]) => mocks.useReplenishmentPoliciesListMock(...args),
  useReplenishmentPolicy: (...args: unknown[]) => mocks.useReplenishmentPolicyMock(...args),
}))

vi.mock('@features/replenishmentPolicies/api', () => ({
  createReplenishmentPolicy: (...args: unknown[]) => mocks.createReplenishmentPolicyMock(...args),
}))

vi.mock('@features/items/queries', () => ({
  useItemsList: (...args: unknown[]) => mocks.useItemsListMock(...args),
  useItem: (...args: unknown[]) => mocks.useItemMock(...args),
}))

vi.mock('@features/locations/queries', () => ({
  useLocationsList: (...args: unknown[]) => mocks.useLocationsListMock(...args),
  useLocation: (...args: unknown[]) => mocks.useLocationMock(...args),
}))

vi.mock('@features/kpis/queries', () => ({
  kpisQueryKeys: {
    replenishmentPoliciesPrefix: () => ['planning', 'replenishment-policies'] as const,
    replenishmentRecommendationsPrefix: () => ['planning', 'replenishment'] as const,
    dashboardOverviewPrefix: () => ['dashboard', 'overview'] as const,
  },
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mocks.navigateMock,
  }
})

function successQuery<T>(data: T) {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }
}

beforeEach(() => {
  mocks.useReplenishmentPoliciesListMock.mockReset()
  mocks.useReplenishmentPolicyMock.mockReset()
  mocks.useItemsListMock.mockReset()
  mocks.useItemMock.mockReset()
  mocks.useLocationsListMock.mockReset()
  mocks.useLocationMock.mockReset()
  mocks.createReplenishmentPolicyMock.mockReset()
  mocks.invalidateQueriesMock.mockReset()
  mocks.navigateMock.mockReset()

  mocks.useReplenishmentPoliciesListMock.mockReturnValue(successQuery({ data: [], paging: { limit: 50, offset: 0 } }))
  mocks.useReplenishmentPolicyMock.mockReturnValue(successQuery(null))
  mocks.useItemsListMock.mockReturnValue(successQuery({ data: [] }))
  mocks.useItemMock.mockReturnValue(successQuery(undefined))
  mocks.useLocationsListMock.mockReturnValue(successQuery({ data: [] }))
  mocks.useLocationMock.mockReturnValue(successQuery(undefined))
})

describe('replenishment policy pages', () => {
  it('shows no-items empty state on the list page', () => {
    renderWithQueryClient(
      <MemoryRouter>
        <ReplenishmentPoliciesListPage />
      </MemoryRouter>,
    )

    expect(screen.getByText('No items available')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go to Items' })).toBeInTheDocument()
  })

  it('shows dashboard-created success confirmation on the detail page', () => {
    mocks.useReplenishmentPolicyMock.mockReturnValue(
      successQuery({
        id: 'policy-1',
        itemId: 'item-1',
        siteLocationId: 'loc-1',
        uom: 'each',
        policyType: 'min_max',
        status: 'active',
      }),
    )
    mocks.useItemMock.mockReturnValue(
      successQuery({ id: 'item-1', sku: 'A-100', name: 'Alpha', lifecycleStatus: 'Active' }),
    )
    mocks.useLocationMock.mockReturnValue(
      successQuery({ id: 'loc-1', code: 'FG', name: 'Finished Goods', active: true, type: 'warehouse' }),
    )

    renderWithQueryClient(
      <MemoryRouter initialEntries={['/replenishment-policies/policy-1?source=dashboard-created']}>
        <Routes>
          <Route path="/replenishment-policies/:id" element={<ReplenishmentPolicyDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByText('Replenishment policy created')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to dashboard' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View all policies' })).toBeInTheDocument()
  })

  it('uses progressive disclosure on the create form', async () => {
    mocks.useItemsListMock.mockReturnValue(
      successQuery({
        data: [
          {
            id: 'item-1',
            sku: 'A-100',
            name: 'Alpha',
            lifecycleStatus: 'Active',
            defaultUom: 'each',
          },
        ],
      }),
    )
    mocks.useLocationsListMock.mockReturnValue(
      successQuery({
        data: [{ id: 'loc-1', code: 'FG', name: 'Finished Goods', active: true, type: 'warehouse' }],
      }),
    )
    mocks.createReplenishmentPolicyMock.mockResolvedValue({ id: 'policy-1' })

    renderWithQueryClient(
      <MemoryRouter initialEntries={['/replenishment-policies/new']}>
        <Routes>
          <Route path="/replenishment-policies/new" element={<ReplenishmentPolicyCreatePage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByText('Order up to level')).toBeInTheDocument()
    expect(screen.queryByText('Fixed order quantity')).not.toBeInTheDocument()
    expect(screen.queryByText('Safety stock quantity')).not.toBeInTheDocument()

    fireEvent.change(screen.getByDisplayValue('None'), { target: { value: 'fixed' } })
    expect(screen.getByText('Safety stock quantity')).toBeInTheDocument()

    fireEvent.change(screen.getByDisplayValue('Min-Max (s,S)'), { target: { value: 'q_rop' } })
    expect(screen.getByText('Fixed order quantity')).toBeInTheDocument()
    expect(screen.queryByText('Order up to level')).not.toBeInTheDocument()
  })
})
