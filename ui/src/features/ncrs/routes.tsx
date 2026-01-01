import { AppRouteObject } from '../../shared/routes'
import NcrListPage from './pages/NcrListPage'
import NcrDetailPage from './pages/NcrDetailPage'

export const ncrRoutes: AppRouteObject[] = [
  {
    path: 'ncrs',
    handle: {
      breadcrumb: 'NCRs',
      nav: {
        label: 'NCRs',
        to: '/ncrs',
        order: 90, // Adjust order as needed
      },
    },
    children: [
      {
        index: true,
        element: <NcrListPage />,
      },
      {
        path: ':id',
        element: <NcrDetailPage />,
        handle: {
          breadcrumb: 'NCR Details',
        },
      },
    ],
  },
]
