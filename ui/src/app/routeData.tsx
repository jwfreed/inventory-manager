import type { AppNavItem, AppRouteObject } from '../shared/routes'
import HomePage from '../pages/Home'
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

const coreRoutes: AppRouteObject[] = [
  {
    path: 'home',
    element: <HomePage />,
    handle: {
      breadcrumb: 'Home',
      nav: {
        label: 'Dashboard',
        to: '/home',
        section: 'dashboard',
        order: 10,
        description: 'Overview and key metrics',
      },
    },
  },
]

export const appShellRoutes: AppRouteObject[] = [
  ...coreRoutes,
  ...kpiRoutes,
  ...ledgerRoutes,
  ...adjustmentRoutes,
  ...atpRoutes,
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
  {
    path: 'not-found',
    element: <NotFoundPage />,
    handle: {
      breadcrumb: 'Not found',
    },
  },
]

export const navItems: AppNavItem[] = appShellRoutes
  .map((route) => route.handle?.nav)
  .filter((item): item is AppNavItem => Boolean(item))
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
