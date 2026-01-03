import type { AppRouteObject } from '../../shared/routes'
import ItemDetailPage from './pages/ItemDetailPage'
import ItemsListPage from './pages/ItemsListPage'

export const itemRoutes: AppRouteObject[] = [
  {
    path: 'items',
    element: <ItemsListPage />,
    handle: {
      breadcrumb: 'Items',
      nav: {
        label: 'Items',
        to: '/items',
        section: 'master-data',
        order: 70,
        description: 'Product and material master data',
      },
    },
  },
  {
    path: 'items/:id',
    element: <ItemDetailPage />,
    handle: {
      breadcrumb: 'Item',
    },
  },
]
