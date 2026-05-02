import type { AppRouteObject } from '../../shared/routes'
import InventoryHealthPage from './pages/InventoryHealthPage'
import ImportDataPage from './pages/ImportDataPage'

export const adminRoutes: AppRouteObject[] = [
  {
    path: '/admin/inventory-health',
    element: <InventoryHealthPage />,
    handle: {
      breadcrumb: 'Inventory Health',
      permission: 'admin:health',
      nav: {
        label: 'Inventory Health',
        to: '/admin/inventory-health',
        section: 'admin',
        order: 90,
        description: 'Admin diagnostics for inventory data health checks',
        permission: 'admin:health',
      },
    },
  },
  {
    path: '/admin/imports',
    element: <ImportDataPage />,
    handle: {
      breadcrumb: 'Data Import',
      permission: 'admin:imports',
      nav: {
        label: 'Data Import',
        to: '/admin/imports',
        section: 'admin',
        order: 80,
        permission: 'admin:imports',
      },
    },
  },
]
