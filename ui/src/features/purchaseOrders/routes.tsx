import type { AppRouteObject } from '../../shared/routes'
import PurchaseOrderCreatePage from './pages/PurchaseOrderCreatePage'
import PurchaseOrderDetailPage from './pages/PurchaseOrderDetailPage'
import PurchaseOrdersListPage from './pages/PurchaseOrdersListPage'

export const purchaseOrderRoutes: AppRouteObject[] = [
  {
    path: 'purchase-orders',
    element: <PurchaseOrdersListPage />,
    handle: {
      breadcrumb: 'Purchase Orders',
      permission: 'purchasing:read',
      nav: {
        label: 'Purchase Orders',
        to: '/purchase-orders',
        section: 'inbound',
        order: 22,
        description: 'Create and manage purchase orders',
      },
    },
  },
  {
    path: 'purchase-orders/new',
    element: <PurchaseOrderCreatePage />,
    handle: {
      breadcrumb: 'New purchase order',
      permission: 'purchasing:write',
    },
  },
  {
    path: 'purchase-orders/:id',
    element: <PurchaseOrderDetailPage />,
    handle: {
      breadcrumb: 'Purchase order',
      permission: 'purchasing:read',
    },
  },
]
