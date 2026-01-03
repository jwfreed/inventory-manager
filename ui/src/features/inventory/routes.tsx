import type { AppRouteObject } from '../../shared/routes'
import { AtpQueryPage } from './pages/AtpQueryPage'
import { LicensePlatesPage } from './pages/LicensePlatesPage'

export const atpRoutes: AppRouteObject[] = [
  {
    path: 'atp',
    element: <AtpQueryPage />,
    handle: {
      breadcrumb: 'Available to Promise',
      nav: {
        label: 'Available-to-Promise',
        to: '/atp',
        section: 'inventory',
        order: 35,
        description: 'Check inventory availability for orders',
      },
    },
  },
  {
    path: 'lpns',
    element: <LicensePlatesPage />,
    handle: {
      breadcrumb: 'License Plates',
      nav: {
        label: 'License Plates',
        to: '/lpns',
        section: 'inventory',
        order: 34,
        description: 'Manage license plate tracking',
      },
    },
  },
]
