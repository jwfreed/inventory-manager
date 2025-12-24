import type { AppNavItem, AppRouteObject } from '../shared/routes'
import HomePage from '../pages/Home'
import NotFoundPage from '../pages/NotFound'
import { itemRoutes } from '../features/items'
import { kpiRoutes } from '../features/kpis'
import { ledgerRoutes } from '../features/ledger'
import { locationRoutes } from '../features/locations'
import { orderToCashRoutes } from '../features/orderToCash'
import { purchaseOrderRoutes } from '../features/purchaseOrders'
import { receivingRoutes } from '../features/receiving'
import { vendorRoutes } from '../features/vendors'
import { workOrderRoutes } from '../features/workOrders'

const coreRoutes: AppRouteObject[] = [
  {
    path: 'home',
    element: <HomePage />,
    handle: {
      breadcrumb: 'Home',
      nav: {
        label: 'Home',
        to: '/home',
        order: 1,
      },
    },
  },
]

export const appShellRoutes: AppRouteObject[] = [
  ...coreRoutes,
  ...kpiRoutes,
  ...ledgerRoutes,
  ...workOrderRoutes,
  ...purchaseOrderRoutes,
  ...vendorRoutes,
  ...receivingRoutes,
  ...itemRoutes,
  ...locationRoutes,
  ...orderToCashRoutes,
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
