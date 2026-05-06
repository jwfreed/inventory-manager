import type { AppRouteObject } from '../../shared/routes'
import VendorsListPage from './pages/VendorsListPage'
import { SupplierScorecardsPage } from './pages/SupplierScorecardsPage'

export const vendorRoutes: AppRouteObject[] = [
  {
    path: 'vendors',
    element: <VendorsListPage />,
    handle: {
      breadcrumb: 'Suppliers',
      permission: 'masterdata:read',
      nav: {
        label: 'Suppliers',
        to: '/vendors',
        section: 'inbound',
        order: 20,
        description: 'Manage supplier information',
      },
    },
  },
  {
    path: 'supplier-scorecards',
    element: <SupplierScorecardsPage />,
    handle: {
      breadcrumb: 'Supplier Scorecards',
      permission: 'purchasing:read',
      nav: {
        label: 'Supplier Scorecards',
        to: '/supplier-scorecards',
        section: 'inbound',
        order: 21,
        description: 'Track supplier performance metrics',
      },
    },
  },
  {
    path: 'supplier-scorecards/:vendorId',
    element: <SupplierScorecardsPage />,
    handle: {
      breadcrumb: 'Supplier Scorecard',
      permission: 'purchasing:read',
    },
  },
]
