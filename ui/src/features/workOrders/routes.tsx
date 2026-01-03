import type { AppRouteObject } from '../../shared/routes'
import WorkOrderCreatePage from './pages/WorkOrderCreatePage'
import WorkOrderDetailPage from './pages/WorkOrderDetailPage'
import WorkOrdersListPage from './pages/WorkOrdersListPage'

export const workOrderRoutes: AppRouteObject[] = [
  {
    path: 'work-orders',
    element: <WorkOrdersListPage />,
    handle: {
      breadcrumb: 'Work Orders',
      nav: {
        label: 'Work Orders',
        to: '/work-orders',
        section: 'production',
        order: 40,
        description: 'Manufacturing orders and execution',
      },
    },
  },
  {
    path: 'work-orders/new',
    element: <WorkOrderCreatePage />,
    handle: {
      breadcrumb: 'New work order',
    },
  },
  {
    path: 'work-orders/:id',
    element: <WorkOrderDetailPage />,
    handle: {
      breadcrumb: 'Work order',
    },
  },
]
