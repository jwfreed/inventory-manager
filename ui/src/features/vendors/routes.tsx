import type { AppRouteObject } from '../../shared/routes'
import VendorsListPage from './pages/VendorsListPage'
import { SupplierScorecardsPage } from './pages/SupplierScorecardsPage'

export const vendorRoutes: AppRouteObject[] = [
  {
    path: 'vendors',
    element: <VendorsListPage />,
    handle: {
      breadcrumb: 'Vendors',
      nav: {
        label: 'Vendors',
        to: '/vendors',
        order: 6,
      },
    },
  },
  {
    path: 'supplier-scorecards',
    element: <SupplierScorecardsPage />,
    handle: {
      breadcrumb: 'Supplier Scorecards',
      nav: {
        label: 'Scorecards',
        to: '/supplier-scorecards',
        order: 7,
      },
    },
  },
]
