import type { AppRouteObject } from '../../shared/routes'
import InventoryHealthPage from './pages/InventoryHealthPage'

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
]
