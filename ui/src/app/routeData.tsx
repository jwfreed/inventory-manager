import type { AppNavItem, AppRouteObject } from '../shared/routes'
import { Navigate } from 'react-router-dom'
import NotFoundPage from '../pages/NotFound'
import { itemRoutes } from '../features/items'
import { kpiRoutes } from '../features/kpis'
import { ledgerRoutes } from '../features/ledger'
import { adjustmentRoutes } from '../features/adjustments'
import { locationRoutes } from '../features/locations'
import { orderToCashRoutes } from '../features/orderToCash'
import { purchaseOrderRoutes } from '../features/purchaseOrders'
import { receivingRoutes } from '../features/receiving'
import { vendorRoutes } from '../features/vendors'
import { workOrderRoutes } from '../features/workOrders'
import { profileRoutes } from '../features/profile'
import { routingsRoutes } from '../features/routings/index'
import { ncrRoutes } from '../features/ncrs/routes'
import { atpRoutes } from '../features/inventory/routes'
import { reportRoutes } from '../features/reports/routes'
import { apRoutes } from '../features/ap'
import { adminRoutes } from '../features/admin'
import { replenishmentPolicyRoutes } from '../features/replenishmentPolicies'

const coreRoutes: AppRouteObject[] = [
  {
    path: 'home',
    element: <Navigate to="/dashboard" replace />,
  },
]

export const appShellRoutes: AppRouteObject[] = [
  ...coreRoutes,
  ...kpiRoutes,
  ...ledgerRoutes,
  ...adjustmentRoutes,
  ...atpRoutes,
  ...replenishmentPolicyRoutes,
  ...reportRoutes,
  ...apRoutes,
  ...workOrderRoutes,
  ...purchaseOrderRoutes,
  ...vendorRoutes,
  ...receivingRoutes,
  ...itemRoutes,
  ...locationRoutes,
  ...orderToCashRoutes,
  ...profileRoutes,
  ...routingsRoutes,
  ...ncrRoutes,
  ...adminRoutes,
  {
    path: 'not-found',
    element: <NotFoundPage />,
    handle: {
      breadcrumb: 'Not found',
    },
  },
]

function collectNavItems(routes: AppRouteObject[], inheritedPermission?: string): AppNavItem[] {
  return routes.flatMap((route) => {
    const permission = route.handle?.permission ?? inheritedPermission
    const nav = route.handle?.nav
    return [
      ...(nav ? [{ ...nav, permission: nav.permission ?? permission }] : []),
      ...(route.children ? collectNavItems(route.children, permission) : []),
    ]
  })
}

export const navItems: AppNavItem[] = collectNavItems(appShellRoutes)
  .filter((item): item is AppNavItem => Boolean(item))
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
