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
      nav: {
        label: 'Purchase Orders',
        to: '/purchase-orders',
        order: 5,
      },
    },
  },
  {
    path: 'purchase-orders/new',
    element: <PurchaseOrderCreatePage />,
    handle: {
      breadcrumb: 'New purchase order',
    },
  },
  {
    path: 'purchase-orders/:id',
    element: <PurchaseOrderDetailPage />,
    handle: {
      breadcrumb: 'Purchase order',
    },
  },
]
