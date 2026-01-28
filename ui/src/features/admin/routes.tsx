import type { AppRouteObject } from '../../shared/routes'
import InventoryHealthPage from './pages/InventoryHealthPage'
import ImportDataPage from './pages/ImportDataPage'

export const adminRoutes: AppRouteObject[] = [
  {
    path: '/admin/inventory-health',
    element: <InventoryHealthPage />,
    handle: {
      breadcrumb: 'Inventory Health',
      nav: {
        label: 'Inventory Health',
        to: '/admin/inventory-health',
        section: 'admin',
        order: 90,
      },
    },
  },
  {
    path: '/admin/imports',
    element: <ImportDataPage />,
    handle: {
      breadcrumb: 'Data Import',
      nav: {
        label: 'Data Import',
        to: '/admin/imports',
        section: 'admin',
        order: 80,
      },
    },
  },
]
