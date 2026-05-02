import type { AppRouteObject } from '@shared/routes'
import ReplenishmentPoliciesListPage from './pages/ReplenishmentPoliciesListPage'
import ReplenishmentPolicyCreatePage from './pages/ReplenishmentPolicyCreatePage'
import ReplenishmentPolicyDetailPage from './pages/ReplenishmentPolicyDetailPage'

export const replenishmentPolicyRoutes: AppRouteObject[] = [
  {
    path: 'replenishment-policies',
    element: <ReplenishmentPoliciesListPage />,
    handle: {
      breadcrumb: 'Replenishment Policies',
      permission: 'planning:read',
      nav: {
        label: 'Replenishment Policies',
        to: '/replenishment-policies',
        section: 'inventory',
        order: 40,
        description: 'Configure item-location replenishment policy scopes',
      },
    },
  },
  {
    path: 'replenishment-policies/new',
    element: <ReplenishmentPolicyCreatePage />,
    handle: {
      breadcrumb: 'Create policy',
      permission: 'planning:write',
    },
  },
  {
    path: 'replenishment-policies/:id',
    element: <ReplenishmentPolicyDetailPage />,
    handle: {
      breadcrumb: 'Policy',
      permission: 'planning:read',
    },
  },
]
