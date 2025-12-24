import type { AppRouteObject } from '../../shared/routes'
import VendorsListPage from './pages/VendorsListPage'

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
]
