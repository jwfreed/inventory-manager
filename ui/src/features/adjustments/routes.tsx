import type { AppRouteObject } from '../../shared/routes'
import AdjustmentsListPage from './pages/AdjustmentsListPage'
import AdjustmentNewPage from './pages/AdjustmentNewPage'
import AdjustmentDetailPage from './pages/AdjustmentDetailPage'

export const adjustmentRoutes: AppRouteObject[] = [
  {
    path: 'inventory-adjustments',
    element: <AdjustmentsListPage />,
    handle: {
      breadcrumb: 'Inventory adjustments',
      nav: {
        label: 'Adjustments',
        to: '/inventory-adjustments',
        section: 'inventory',
        order: 33,
        description: 'Record quantity and value adjustments',
      },
    },
  },
  {
    path: 'inventory-adjustments/new',
    element: <AdjustmentNewPage />,
    handle: {
      breadcrumb: 'New adjustment',
    },
  },
  {
    path: 'inventory-adjustments/:id',
    element: <AdjustmentDetailPage />,
    handle: {
      breadcrumb: 'Adjustment detail',
    },
  },
]
