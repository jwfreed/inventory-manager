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
        label: 'ATP Query',
        to: '/atp',
        order: 5,
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
        order: 6,
      },
    },
  },
]
