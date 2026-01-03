import type { AppRouteObject } from '../../shared/routes'
import MovementDetailPage from './pages/MovementDetailPage'
import MovementsListPage from './pages/MovementsListPage'

export const ledgerRoutes: AppRouteObject[] = [
  {
    path: 'movements',
    element: <MovementsListPage />,
    handle: {
      breadcrumb: 'Inventory movements',
      nav: {
        label: 'Inventory Movements',
        to: '/movements',
        section: 'inventory',
        order: 32,
        description: 'View all inventory transactions',
      },
    },
  },
  {
    path: 'movements/:movementId',
    element: <MovementDetailPage />,
    handle: {
      breadcrumb: 'Movement detail',
    },
  },
]
