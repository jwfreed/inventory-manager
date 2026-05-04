import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '../testUtils'
import ItemsListPage from '../../features/items/pages/ItemsListPage'

let authPermissions: string[] = ['masterdata:write']

vi.mock('@shared/auth', () => ({
  useAuth: () => ({
    hasPermission: (permission: string) => authPermissions.includes(permission),
    user: null,
  }),
}))

vi.mock('../../features/items/queries', () => ({
  useItemsList: vi.fn(),
  useItemsMetrics: vi.fn(),
}))

vi.mock('../../features/inventory/queries', () => ({
  useInventorySnapshotSummary: vi.fn(),
}))

vi.mock('@features/onboarding/hooks', () => ({
  useOnboarding: vi.fn(),
}))

vi.mock('../../app/layout/usePageChrome', () => ({
  usePageChrome: vi.fn(),
}))

vi.mock('@features/onboarding/components/OnboardingTip', () => ({
  default: () => null,
}))

vi.mock('@features/onboarding/state', () => ({
  isTipDismissed: vi.fn().mockReturnValue(true),
  markTipDismissed: vi.fn(),
}))

vi.mock('@features/onboarding/analytics', () => ({
  trackOnboardingEvent: vi.fn(),
}))

import { useItemsList, useItemsMetrics } from '../../features/items/queries'
import { useInventorySnapshotSummary } from '../../features/inventory/queries'
import { useOnboarding } from '@features/onboarding/hooks'
import { usePageChrome } from '../../app/layout/usePageChrome'

const mockedUseItemsList = vi.mocked(useItemsList)
const mockedUseItemsMetrics = vi.mocked(useItemsMetrics)
const mockedUseInventorySnapshotSummary = vi.mocked(useInventorySnapshotSummary)
const mockedUseOnboarding = vi.mocked(useOnboarding)
const mockedUsePageChrome = vi.mocked(usePageChrome)

function renderPage() {
  const router = createMemoryRouter(
    [{ path: '/', element: <ItemsListPage /> }],
    { initialEntries: ['/'] },
  )
  return renderWithQueryClient(<RouterProvider router={router} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  authPermissions = ['masterdata:write']
  // jsdom does not implement scrollIntoView
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  mockedUsePageChrome.mockReturnValue({ hideTitle: false } as any)
  mockedUseOnboarding.mockReturnValue({
    progress: { tipsShown: {}, userRole: null, businessType: null, pathChosen: null },
    markTipShown: vi.fn(),
  } as any)
  mockedUseItemsList.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() } as any)
  mockedUseItemsMetrics.mockReturnValue({ data: [], isLoading: false, isError: false, error: null } as any)
  mockedUseInventorySnapshotSummary.mockReturnValue({ data: null, isLoading: false, isError: false, error: null } as any)
})

describe('ItemsListPage: masterdata:write guard on New item', () => {
  it('enables New item button when masterdata:write is present', async () => {
    renderPage()
    expect(await screen.findByRole('button', { name: 'New item' })).not.toBeDisabled()
  })

  it('disables New item button when masterdata:write is absent', async () => {
    authPermissions = []
    renderPage()
    expect(await screen.findByRole('button', { name: 'New item' })).toBeDisabled()
  })

  it('does not open create form when unauthorized user clicks New item', async () => {
    authPermissions = []
    renderPage()
    const newItemBtn = await screen.findByRole('button', { name: 'New item' })
    fireEvent.click(newItemBtn)
    // create panel should not appear
    expect(screen.queryAllByText('Create item')).toHaveLength(0)
  })

  it('opens create form when authorized user clicks New item', async () => {
    renderPage()
    const newItemBtn = await screen.findByRole('button', { name: 'New item' })
    fireEvent.click(newItemBtn)
    expect(screen.getAllByText('Create item').length).toBeGreaterThan(0)
  })
})
